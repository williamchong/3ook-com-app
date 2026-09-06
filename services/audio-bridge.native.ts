import NetInfo from '@react-native-community/netinfo';
import CookieManager from '@preeternal/react-native-cookie-manager';
import {
  createAudioPlayer,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  type AudioPlayer,
  type AudioStatus,
} from 'expo-audio';
import { AppState, Platform } from 'react-native';
import { requestBatteryOptimizationExemption } from '../modules/battery-optimization';

import {
  addInterruptionBeganListener,
  addInterruptionEndedListener,
} from '../modules/audio-interruption';

import { trackEvent } from './analytics';
import type { LoadMessage } from './audio-bridge';
import {
  clearAudioCache,
  ensureCachedAudio,
  evictCachedAudio,
  getCachedAudioUri,
  isAudioCacheEnabled,
  normalizeUrl,
} from './audio-cache';
import type { SendToWebView, BridgeHandlerMap } from './bridge-dispatcher';
import { armStoreReview, recordListening, setAudioActive } from './store-review';

interface QueueTrack {
  uri: string;
  headers?: Record<string, string>;
  title: string;
  artist: string;
  artworkUrl: string;
}

type PreloadState = 'hit' | 'miss' | 'fresh';

// Whether a segment was already on disk. Reported on audio events so a cache
// serving bad files shows up as a hit-skewed stall rate.
type CacheState = 'hit' | 'miss';

// Which call hit a deactivated audio session. Reported so a session that never
// recovers is distinguishable from a plain network stall.
type SessionRetryStage = 'player_activation' | 'stuck_retry' | 'resume' | 'interruption_resume';

let playerA: AudioPlayer | null = null;
let playerB: AudioPlayer | null = null;
let activeSlot: 'A' | 'B' = 'A';
// downloadingIndex covers the window before the idle player has the source.
// Deliberately NOT read by handleSkipTo: the idle player still holds the
// previous segment then, so counting it a preload hit would play wrong audio.
const preload = { readyIndex: -1, loadingIndex: -1, downloadingIndex: -1, resetCount: 0 };
let idleSub: { remove(): void } | null = null;

// 120 is ~26 minutes at the 13s median segment, a few MB against a 150MB cache
// budget. Clamped here because this side owns the bandwidth it spends.
const MAX_PREFETCH_COUNT = 120;

// Disk lookahead state. `cursor` is the next index to examine, so a warm window
// costs no re-stat per status tick; `generation` is bumped by load/stop so a
// loop parked on a download abandons a queue it no longer belongs to.
// `base` is the playhead the cursor was computed against, so a backward skip is
// detectable and the cursor can be rewound.
const prefetch = { depth: 1, generation: 0, running: false, armed: false, cursor: 0, base: -1 };

let queue: QueueTrack[] = [];
let currentIndex = -1;
let currentRate = 1;
let lastFinishTime = 0;
let ttsSessionId: string | undefined;

// Minimum listening within one load before finishing the queue counts as
// "finished a book" for the review prompt. Rejects skipping to the last
// segment, resuming near the end, and short samples.
const MIN_SESSION_LISTENED_MS = 10 * 60 * 1000;
const MAX_LISTEN_CHUNK_MS = 6 * 60 * 60 * 1000;
let playingSince = 0;
let sessionListenedMs = 0;
let loadPromise: Promise<void> = Promise.resolve();
let sessionReleasePromise: Promise<void> | null = null;
let notifyWebView: SendToWebView | null = null;
let lastSentState = '';
let lastSentWarmedThrough = -1;

// Stuck detection state
// Longer than web player's 5s because iOS uses blocking=1 URLs where the
// server generates the full TTS audio before responding.
const STUCK_TIMEOUT_MS = 15000;
// Playhead movement over a whole stuck window that still counts as stalled. A
// stream that rendered a fraction of a second and then starved is dead, not slow.
const MIN_PROGRESS_S = 1;
// How often each player emits playbackStatusUpdate (expo-audio default: 500ms).
// With two persistent players that polling is a steady background CPU/battery
// cost; 1000ms halves it. onStatus only needs coarse state transitions, and
// gapless auto-advance rides the separate AVPlayerItem end notification
// (didJustFinish), not this interval.
const STATUS_UPDATE_INTERVAL_MS = 1000;
let active = false;
let stuckTimer: ReturnType<typeof setTimeout> | null = null;
let stuckRetried = false;
let errored = false;

// Connectivity at the moment an audio event fires. Offline replay is the whole
// point of the segment cache, so every audio event carries it — otherwise there
// is no way to tell a cache hit that saved a round trip from one that saved a
// failure. NetInfo reports isConnected as boolean | null; treat unknown as
// online, matching useWebViewRecovery.
let isOnline = true;

// Set when a track's source is handed to a player, consumed when that track
// first reports playing. The gap is what the listener actually waits through,
// which is the metric the cache exists to move — preload_state alone is binary
// and cannot separate a 200ms miss from a 4s one.
let pendingStart: {
  index: number;
  fromIndex: number;
  autoAdvance: boolean;
  at: number;
  preloadState: PreloadState;
  cacheState: CacheState;
} | null = null;

function cacheStateFor(track: QueueTrack): CacheState {
  return getCachedAudioUri(track.uri) ? 'hit' : 'miss';
}

type PlayerSource = { uri: string; headers?: Record<string, string> };

function streamSource(track: QueueTrack): PlayerSource {
  return { uri: track.uri, headers: track.headers };
}

// Play from disk when the segment is already cached, else stream. Read-only:
// the cache is populated by preloadNext alone, never by a segment we are about
// to play. Mirroring while streaming the same segment fetched it twice and put
// the mirror in bandwidth contention with the playback it was mirroring.
// Sync — the lookup is a filesystem stat, cheap enough for the playback path.
function playbackSource(track: QueueTrack): PlayerSource {
  const cachedUri = getCachedAudioUri(track.uri);
  return cachedUri ? { uri: cachedUri } : streamSource(track);
}

function getActivePlayer(): AudioPlayer | null {
  return activeSlot === 'A' ? playerA : playerB;
}

function getIdlePlayer(): AudioPlayer | null {
  return activeSlot === 'A' ? playerB : playerA;
}

function swapSlots(): void {
  activeSlot = activeSlot === 'A' ? 'B' : 'A';
}

function resetIdle(): void {
  preload.readyIndex = -1;
  preload.loadingIndex = -1;
  preload.downloadingIndex = -1;
  preload.resetCount += 1;
  idleSub?.remove();
  idleSub = null;
}

function preloadNext(): void {
  const nextIndex = currentIndex + 1;
  if (nextIndex >= queue.length) return;
  if (
    preload.loadingIndex === nextIndex ||
    preload.readyIndex === nextIndex ||
    preload.downloadingIndex === nextIndex
  ) {
    return;
  }

  resetIdle();

  const idle = getIdlePlayer();
  if (!idle) return;

  const track = queue[nextIndex];
  idle.pause();

  const cachedUri = getCachedAudioUri(track.uri);
  if (cachedUri) {
    startIdleLoad(idle, { uri: cachedUri }, nextIndex);
    return;
  }

  // Preload is the only path that populates the cache: download the segment,
  // then hand the idle player the local file. The previous segment's playback
  // is the runway, so waiting for a complete file costs nothing that streaming
  // into the idle player would have saved; on failure we stream as before.
  // resetCount is captured after resetIdle() so a later reset invalidates this
  // continuation.
  const startResetCount = preload.resetCount;
  preload.downloadingIndex = nextIndex;
  void ensureCachedAudio(track.uri, track.headers).then((localUri) => {
    if (startResetCount !== preload.resetCount) return;
    preload.downloadingIndex = -1;
    // Re-read: the idle slot may have flipped since the download started.
    const target = getIdlePlayer();
    if (!target) return;
    startIdleLoad(target, localUri ? { uri: localUri } : streamSource(track), nextIndex);
  });
}

// After a swap the idle player still reports isLoaded from its old track.
// Wait until we see a buffering/unloaded state (confirming the new source
// started loading) before accepting isLoaded as the preload being ready.
// resetCount guards against a late-firing status event racing resetIdle().
function startIdleLoad(idle: AudioPlayer, source: PlayerSource, nextIndex: number): void {
  const startResetCount = preload.resetCount;
  preload.loadingIndex = nextIndex;
  idle.replace(source);
  idle.setPlaybackRate(currentRate);

  let sawLoading = false;
  idleSub = idle.addListener('playbackStatusUpdate', (status) => {
    if (startResetCount !== preload.resetCount) return;
    if (!status.isLoaded || status.isBuffering) {
      sawLoading = true;
      return;
    }
    if (sawLoading) {
      preload.readyIndex = nextIndex;
      preload.loadingIndex = -1;
      idleSub?.remove();
      idleSub = null;
      // The N+1 buffer is runway too, and it is the whole runway before
      // prefetch has filled anything.
      notifyWarmedThrough();
    }
  });
}

// Fill the disk cache ahead of the playhead so a dropout mid-queue is silent
// rather than a stall. Touches no AudioPlayer: preloadNext keeps its
// single-segment lookahead, and both it and playbackSource read these files.
async function runPrefetch(): Promise<void> {
  const generation = prefetch.generation;
  for (;;) {
    if (generation !== prefetch.generation) return;
    if (!active || !prefetch.armed || !isAudioCacheEnabled() || prefetch.depth <= 1) return;
    // A player that isn't playing is buffering — bandwidth-starved, so
    // competing with it is exactly wrong — or paused, with no runway to protect.
    if (lastSentState !== 'playing') return;

    // currentIndex + 1 belongs to preloadNext.
    const end = Math.min(currentIndex + prefetch.depth, queue.length - 1);
    // Any backward skip leaves segments behind the cursor unexamined; rescan
    // from the window start.
    if (currentIndex < prefetch.base || prefetch.cursor > end + 1) {
      prefetch.cursor = currentIndex + 2;
    }
    prefetch.base = currentIndex;
    let index = Math.max(currentIndex + 2, prefetch.cursor);
    while (index <= end && getCachedAudioUri(queue[index].uri)) index++;
    prefetch.cursor = index;
    if (index > end) return; // Window already full.

    const track = queue[index];
    // null is a bad network or an expired cookie, neither of which the next
    // segment will fix — stop rather than hammer it. A track advance re-arms.
    if (!(await ensureCachedAudio(track.uri, track.headers))) return;
    prefetch.cursor = index + 1;
    notifyWarmedThrough();
  }
}

function schedulePrefetch(): void {
  if (prefetch.running) return;
  prefetch.running = true;
  void runPrefetch().finally(() => {
    prefetch.running = false;
    // Covers every early return above, a stalled window included.
    notifyWarmedThrough();
  });
}

// Drop any in-progress lookahead: the queue, the playhead, or the cache itself
// changed under it. Leaves `running` to the parked loop's own finally.
function resetPrefetch(): void {
  prefetch.generation += 1;
  prefetch.armed = false;
  prefetch.cursor = 0;
  prefetch.base = -1;
}

// Highest index playable with no network, contiguous from the playhead:
// preloadNext's buffered N+1 plus whatever prefetch has put on disk.
function warmedThroughIndex(): number {
  if (!active || currentIndex < 0 || !queue.length) return -1;
  const nextIndex = currentIndex + 1;
  if (nextIndex >= queue.length) return currentIndex;
  // Nothing further along is contiguous with the playhead without this one.
  // getCachedAudioUri self-gates on the cache flag, so no guard here.
  const nextIsWarm =
    preload.readyIndex === nextIndex || !!getCachedAudioUri(queue[nextIndex].uri);
  if (!nextIsWarm) return currentIndex;
  if (!isAudioCacheEnabled()) return nextIndex;
  // Read the cursor the prefetch scan already advanced rather than re-stat the
  // window every status tick. A backward skip leaves the gap below the old base
  // unexamined, which is the one case the cursor can't answer.
  if (currentIndex < prefetch.base) return nextIndex;
  return Math.max(nextIndex, prefetch.cursor - 1);
}

// See the warmDepth capability in app/index.tsx for why web needs this. `force`
// resends after a suspended WebView dropped one, where the value may be
// unchanged and -1 is a real index rather than a spare sentinel.
function notifyWarmedThrough(force = false): void {
  const index = warmedThroughIndex();
  if (!force && index === lastSentWarmedThrough) return;
  lastSentWarmedThrough = index;
  notifyWebView?.({ type: 'warmedThrough', index });
}

function getOrCreatePlayers(): AudioPlayer {
  // keepAudioSessionActive prevents expo-audio from deactivating the
  // AVAudioSession on every pause()/track end. Without this, the swap from
  // player A to player B races a 100ms-deferred session deactivation on iOS,
  // producing audible gaps and clicks between segments. handleStop() must
  // explicitly call setIsAudioActiveAsync(false) to release the session.
  if (!playerA) {
    playerA = createAudioPlayer(null, { keepAudioSessionActive: true, updateInterval: STATUS_UPDATE_INTERVAL_MS });
  }
  if (!playerB) {
    playerB = createAudioPlayer(null, { keepAudioSessionActive: true, updateInterval: STATUS_UPDATE_INTERVAL_MS });
  }
  return getActivePlayer()!;
}

function clearStuckTimer(): void {
  if (stuckTimer) {
    clearTimeout(stuckTimer);
    stuckTimer = null;
  }
}

function resetRecoveryState(): void {
  errored = false;
  stuckRetried = false;
}

function armStuckTimer(): void {
  clearStuckTimer();
  // Baseline for the progress test below: how far the playhead moves over a
  // stuck window separates a dead stream from a slow one still filling.
  const armedAt = getActivePlayer()?.currentTime ?? 0;
  stuckTimer = setTimeout(() => {
    // 'paused' covers a lock-screen or interruption pause, which bypasses
    // handlePause and so leaves this timer armed. Re-issuing there would spend
    // a fresh blocking synthesis on audio the listener just stopped.
    if (lastSentState === 'playing' || lastSentState === 'paused') return;
    if (!active || stuckRetried || errored) return;
    console.warn('Audio stuck — retrying playback');
    stuckRetried = true;
    const p = getActivePlayer();
    if (!p) return;
    const track = queue[currentIndex];
    const cacheState: CacheState = track ? cacheStateFor(track) : 'miss';
    trackEvent('audio_stuck_retry', {
      current_index: currentIndex,
      cache_state: cacheState,
      is_online: isOnline,
      advanced_ms: Math.round((p.currentTime - armedAt) * 1000),
    });
    // Two stalls share this path: a deactivated iOS session, which the
    // re-assert fixes, and a hung fetch, which needs the source re-issued.
    reassertSession(
      'stuck_retry',
      p,
      () => {
        // Progress, read after the session await, is the test: isLoaded and
        // isBuffering both stay true on a hung fetch, so they cannot gate this.
        if (track && p.currentTime - armedAt < MIN_PROGRESS_S) {
          // Pause before replace so iOS doesn't schedule its own auto-resume that
          // races the play() below and mis-binds didJustFinish (see playTrack).
          p.pause();
          // Stream past a cached copy that just stalled: replaying it off disk
          // would reproduce the same stall. Offline it is all we have.
          p.replace(cacheState === 'hit' && isOnline ? streamSource(track) : playbackSource(track));
          p.setPlaybackRate(currentRate);
        }
        p.play();
      },
      // The stall gets one retry, so take it even if re-activation failed.
      true,
    );
    stuckTimer = setTimeout(() => {
      stuckTimer = null;
      // 'paused' stands this leg down for the same reason as the retry above:
      // a lock-screen pause leaves `active` true, and reporting a failure there
      // would evict a good cached segment and surface an error for a stop.
      if (lastSentState === 'playing' || lastSentState === 'paused') return;
      if (!active || errored) return;
      console.warn('Audio stuck — retry failed');
      errored = true;
      // Stalled twice, the second time after a re-issue: the disk copy is
      // suspect and onStatus only evicts on a reported 'failed'. Offline it is
      // unreplaceable, so keep it. cacheState is the snapshot from retry time.
      if (track && cacheState === 'hit' && isOnline) evictCachedAudio(track.uri);
      trackEvent('audio_stuck_failed', {
        current_index: currentIndex,
        cache_state: cacheState,
        is_online: isOnline,
        advanced_ms: Math.round(((getActivePlayer()?.currentTime ?? armedAt) - armedAt) * 1000),
      });
      notifyWebView?.({ type: 'error', message: 'Playback stuck' });
    }, STUCK_TIMEOUT_MS);
  }, STUCK_TIMEOUT_MS);
}

// Wait for any pending release (as doLoad does), re-assert the session, then
// run once more if playback is still wanted. `p` cancels the retry if the queue
// swapped slots meanwhile; pass null to resolve the active player at retry time.
function reassertSession(
  stage: SessionRetryStage,
  p: AudioPlayer | null,
  run: () => void,
  // Run anyway when re-activation fails, for callers whose only attempt this is.
  runIfActivationFails = false,
): void {
  const stillWanted = () => active && !errored && (!p || getActivePlayer() === p);
  Promise.resolve(sessionReleasePromise)
    // A stop mid-await wins — reactivating would hold the session with nothing
    // playing, ducking other apps under interruptionMode 'doNotMix'.
    .then(() => (active && !errored ? setIsAudioActiveAsync(true) : null))
    .then(
      () => {
        if (stillWanted()) run();
      },
      (err) => {
        // Only activation reaches here, so run() cannot have been tried yet.
        if (runIfActivationFails && stillWanted()) run();
        throw err;
      },
    )
    .catch((err) => {
      console.warn(`${stage} failed after session retry:`, err);
      trackEvent('audio_session_retry_failed', {
        stage,
        current_index: currentIndex,
        is_online: isOnline,
      });
    });
}

// Only play() activates the AVAudioSession, and it throws synchronously when
// iOS has left it deactivated. Catch that instead of crashing, then retry once.
function withSessionRetry(stage: SessionRetryStage, p: AudioPlayer, run: () => void): void {
  try {
    run();
  } catch (e) {
    console.warn(`${stage} failed — re-asserting audio session:`, e);
    reassertSession(stage, p, run);
  }
}

function activatePlayer(p: AudioPlayer, track: QueueTrack): void {
  p.setPlaybackRate(currentRate);
  p.setActiveForLockScreen(true, {
    title: track.title,
    artist: track.artist,
    artworkUrl: track.artworkUrl,
  });
  withSessionRetry('player_activation', p, () => p.play());
}

function playTrack(p: AudioPlayer, track: QueueTrack): void {
  resetRecoveryState();

  // Writes lastSentState directly, so stand the listening clock down here too —
  // otherwise the buffering gap before each segment counts as listening.
  updateListening(false);
  lastSentState = 'buffering';
  notifyWebView?.({ type: 'playbackState', state: 'buffering' });

  // Pause before replace so that replaceCurrentSource sees wasPlaying=false
  // and does NOT schedule its own onReady { play() }. Without this, both
  // the internal auto-resume and our explicit play() below race, and
  // addPlaybackEndNotification can register on the wrong AVPlayerItem —
  // causing didJustFinish to never fire.
  p.pause();
  p.replace(playbackSource(track));
  activatePlayer(p, track);
  armStuckTimer();
}

function swapToIdle(track: QueueTrack): void {
  resetRecoveryState();

  const oldActive = getActivePlayer();
  // Pause old player first to prevent brief audio overlap during swap
  oldActive?.pause();

  swapSlots();
  activatePlayer(getActivePlayer()!, track);
  armStuckTimer();

  // Do NOT call oldActive.setActiveForLockScreen(false) here.
  // Explicitly deactivating the old player stops the foreground service on
  // Android (OS may kill the process) and clears Now Playing on iOS before
  // the new player's lock screen info is fully established.
}

let setupDone: Promise<void> | null = null;

export function setupPlayer(): Promise<void> {
  if (!setupDone) {
    setupDone = setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    }).then(() => {
      getOrCreatePlayers();
    });
  }
  return setupDone;
}

// Accrue wall-clock spent actually playing, for the store-review engagement
// gate. Driven off the real player status rather than the `active` flag, since
// a lock-screen pause goes straight to the native player without calling
// handlePause(). Must be called from every lastSentState writer.
function updateListening(isPlaying: boolean): void {
  if (playingSince) {
    const now = Date.now();
    const elapsed = now - playingSince;
    // A clock change or suspended timer, not listening. Dropped from both
    // counters so the session and lifetime totals can't disagree.
    if (elapsed > 0 && elapsed <= MAX_LISTEN_CHUNK_MS) {
      sessionListenedMs += elapsed;
      recordListening(elapsed);
    }
    playingSince = isPlaying ? now : 0;
  } else if (isPlaying) {
    playingSince = Date.now();
  }
  setAudioActive(isPlaying);
}

export function handleLoad(msg: LoadMessage): Promise<void> {
  loadPromise = loadPromise.then(() => doLoad(msg)).catch(() => doLoad(msg));
  return loadPromise;
}

async function doLoad(msg: LoadMessage): Promise<void> {
  // Validate before any side effect: activating the audio session (which ducks
  // other apps under doNotMix) for a malformed message would leave it held
  // forever, since handleStop is the only release path.
  if (!msg.tracks.length || msg.startIndex < 0 || msg.startIndex >= msg.tracks.length) return;

  // The cookie read is independent of the session awaits below; start it now
  // so it overlaps them instead of adding to tap-to-audio latency. On failure
  // proceed without cookies.
  const cookiesPromise = CookieManager.get(msg.tracks[0].url).catch(() => null);

  // Wait for any pending session release from a prior handleStop. Otherwise
  // setIsAudioActiveAsync(false) (background queue) can land after play()'s
  // synchronous activateSession(), leaving the session deactivated.
  const pendingRelease = sessionReleasePromise;
  if (pendingRelease) {
    await pendingRelease;
    if (sessionReleasePromise === pendingRelease) {
      sessionReleasePromise = null;
    }
  }
  await setupPlayer();
  // Re-enable audio after handleStop's setIsAudioActiveAsync(false). On Android
  // that call flips a module-wide `audioEnabled` flag that gates every future
  // play() — without flipping it back, replace()+play() silently no-ops and the
  // player stays in buffering forever (e.g. after a voice-actor switch, which
  // the web app implements as stop → load). iOS treats this as session
  // reactivation, which is also what we want here.
  await setIsAudioActiveAsync(true);

  const p = getOrCreatePlayers();

  const cookies = await cookiesPromise;
  const cookieHeader = cookies
    ? Object.entries(cookies)
        .map(([name, cookie]) => `${name}=${cookie.value}`)
        .join('; ')
    : '';
  const headers = cookieHeader ? { Cookie: cookieHeader } : undefined;

  requestBatteryOptimizationExemption();

  queue = msg.tracks.map((t) => ({
    // Android streams the non-blocking variant; iOS keeps blocking=1. Older web
    // builds still send blocking=1, so strip it here rather than relying on the
    // web to stop.
    uri: Platform.OS === 'android' ? normalizeUrl(t.url) : t.url,
    headers,
    title: t.title || msg.metadata.bookTitle,
    artist: msg.metadata.authorName,
    artworkUrl: msg.metadata.coverUrl,
  }));

  currentIndex = msg.startIndex;
  currentRate = msg.rate;
  lastFinishTime = 0;
  ttsSessionId = msg.ttsSessionId;
  active = true;
  // Clamp rather than trust web. A depth of 1 disables prefetch entirely,
  // which is what every web build predating prefetchCount gets.
  const requestedDepth = Math.floor(Number(msg.prefetchCount));
  prefetch.depth = Number.isFinite(requestedDepth)
    ? Math.min(Math.max(requestedDepth, 1), MAX_PREFETCH_COUNT)
    : 1;
  resetPrefetch();
  // New book (or a voice-actor switch, which the web implements as stop → load):
  // the "finished a book" threshold measures this load only.
  updateListening(false);
  sessionListenedMs = 0;
  clearStuckTimer();
  resetIdle();

  // Idle player may still be buffering its last preload; pause before new queue
  getIdlePlayer()?.pause();

  notifyWebView?.({
    type: 'trackChanged',
    index: currentIndex,
    lastIndex: -1,
    preloadState: 'fresh' satisfies PreloadState,
  });
  // Forced: a new queue starts cold however warm the last one was.
  notifyWarmedThrough(true);
  trackEvent('audio_session_started', {
    track_count: queue.length,
    start_index: currentIndex,
    rate: currentRate,
    is_online: isOnline,
    // Whether the segment cache was live for this session. cache_state alone
    // cannot say: it reads 'miss' both when the cache is off and when it is on
    // but never populating, which is how a dead cache went unnoticed.
    cache_enabled: isAudioCacheEnabled(),
  });
  pendingStart = {
    index: currentIndex,
    fromIndex: -1,
    autoAdvance: false,
    at: Date.now(),
    preloadState: 'fresh',
    cacheState: cacheStateFor(queue[currentIndex]),
  };
  playTrack(p, queue[currentIndex]);
}

export function handlePause(): void {
  active = false;
  clearStuckTimer();
  getActivePlayer()?.pause();
}

export function handleResume(): void {
  active = true;
  errored = false;
  stuckRetried = false;
  // Restart the clock: a segment paused before it ever played would otherwise
  // report the entire paused stretch as load_ms.
  if (pendingStart) pendingStart.at = Date.now();
  const p = getActivePlayer();
  if (p) withSessionRetry('resume', p, () => p.play());
}

export function handleStop(): void {
  if (currentIndex >= 0) {
    trackEvent('audio_session_stopped', { last_index: currentIndex });
  }
  active = false;
  updateListening(false);
  resetRecoveryState();
  clearStuckTimer();
  // Stop filling a queue nobody is listening to.
  resetPrefetch();
  // Skip replace(null) — iOS expo-audio cannot cast null to AudioSource.
  // Pause is enough; players are reused with replace(source) on next load.
  getActivePlayer()?.pause();
  getActivePlayer()?.setActiveForLockScreen(false);
  getIdlePlayer()?.pause();
  getIdlePlayer()?.setActiveForLockScreen(false);
  // Release the AVAudioSession explicitly. Players are created with
  // keepAudioSessionActive: true to avoid mid-queue deactivation, so pause()
  // alone won't free the session for other apps. Track the promise so a
  // fast-following handleLoad can wait for it before reactivating.
  if (setupDone) {
    sessionReleasePromise = setIsAudioActiveAsync(false).catch((e) => {
      console.warn('Failed to release AVAudioSession:', e);
    });
  }
  resetIdle();
  currentIndex = -1;
  queue = [];
  lastSentState = '';
}

export function handleSkipTo(index: number, { resetFinishGuard = true } = {}): void {
  const player = getActivePlayer();
  if (!player || index < 0 || index >= queue.length) return;
  active = true;
  if (resetFinishGuard) lastFinishTime = 0;

  const lastIndex = currentIndex;
  currentIndex = index;

  // In background, playbackStatusUpdate on the idle player may be
  // suspended/coalesced by iOS, so preload.readyIndex never flips even
  // after the idle player has fully buffered. Fall back to querying
  // isLoaded synchronously — if the idle was replaced with this index
  // and is loaded, swapping still beats a fresh replace() on the active
  // player (which triggers a blocking=1 TTS round trip on iOS).
  const idle = getIdlePlayer();
  const idleHasThisTrack = preload.readyIndex === index || preload.loadingIndex === index;
  const preloadState: PreloadState = idleHasThisTrack && idle?.isLoaded ? 'hit' : 'miss';
  // Read before the source is swapped in, so it reports whether the segment was
  // already on disk when we advanced to it rather than after any later write.
  const cacheState = cacheStateFor(queue[index]);
  pendingStart = {
    index,
    fromIndex: lastIndex,
    autoAdvance: !resetFinishGuard,
    at: Date.now(),
    preloadState,
    cacheState,
  };

  if (preloadState === 'hit') {
    swapToIdle(queue[currentIndex]);
  } else {
    resetIdle();
    playTrack(player, queue[currentIndex]);
  }

  notifyWebView?.({
    type: 'trackChanged',
    index: currentIndex,
    lastIndex,
    preloadState,
  });
  preloadNext();
  // Arm only once a segment boundary has been crossed: a book sampled and
  // abandoned would otherwise force a whole window of blocking TTS synthesis.
  prefetch.armed = true;
  schedulePrefetch();
  // Publish the window schedulePrefetch just rescanned synchronously; its own
  // finally may be a whole download away.
  notifyWarmedThrough();
}

export function handleSetRate(rate: number): void {
  currentRate = rate;
  getActivePlayer()?.setPlaybackRate(rate);
  getIdlePlayer()?.setPlaybackRate(rate);
}

export async function handleSeekTo(position: number): Promise<void> {
  const p = getActivePlayer();
  if (!p) return;
  // A seek moves the playhead the stuck check measures, so restart the window
  // against the new position rather than reading the jump as progress.
  clearStuckTimer();
  await p.seekTo(position);
  if (active) armStuckTimer();
}

export function getAudioHandlers(): BridgeHandlerMap {
  return {
    load: (msg) => handleLoad(msg as unknown as LoadMessage),
    pause: () => handlePause(),
    resume: () => handleResume(),
    stop: () => handleStop(),
    skipTo: (msg) => {
      if (typeof msg.index === 'number') handleSkipTo(msg.index);
    },
    setRate: (msg) => {
      if (typeof msg.rate === 'number') handleSetRate(msg.rate);
    },
    seekTo: (msg) => {
      if (typeof msg.position === 'number') {
        return handleSeekTo(msg.position);
      }
    },
    // App-managed content caches — currently just TTS audio; hook future
    // content caches in here. The WebView HTTP/SW cache stays separate
    // (clearWebViewCache — it reloads); logout also clears via resetUser.
    // resetPrefetch too: the cursor records what used to be on disk, and the
    // files it counted are gone.
    clearNativeCaches: () => {
      clearAudioCache();
      resetPrefetch();
      notifyWarmedThrough();
    },
  };
}

export function registerEventListeners(sendToWebView: SendToWebView) {
  notifyWebView = sendToWebView;
  lastSentState = '';
  lastSentWarmedThrough = -1;
  getOrCreatePlayers();

  function onStatus(sourcePlayer: AudioPlayer, status: AudioStatus) {
    // Ignore events from the idle player
    if (sourcePlayer !== getActivePlayer()) return;

    // Detect playback errors (AVPlayer status = "failed")
    if (status.playbackState === 'failed') {
      errored = true;
      clearStuckTimer();
      // Evict any cached copy of the failing track — a corrupt file would
      // otherwise fail identically on every future replay of this segment.
      const failedTrack = queue[currentIndex];
      // Read before evicting, or the eviction below makes every failure a miss.
      const failedCacheState = failedTrack ? cacheStateFor(failedTrack) : 'miss';
      if (failedTrack) evictCachedAudio(failedTrack.uri);
      // 'failed' is sticky and returns before the transition below, so the
      // listening clock would otherwise run until the next load — crediting
      // hours of silence and pinning audioActive true.
      updateListening(false);
      trackEvent('audio_playback_failed', {
        current_index: currentIndex,
        cache_state: failedCacheState,
        is_online: isOnline,
      });
      notifyWebView?.({ type: 'error', message: 'Playback failed' });
      return;
    }

    // Map expo-audio status to state strings
    let state: string;
    if (!status.isLoaded || status.isBuffering) {
      state = 'buffering';
    } else if (status.playing) {
      state = 'playing';
    } else {
      state = 'paused';
    }
    if (state !== lastSentState) {
      updateListening(state === 'playing');
      lastSentState = state;
      notifyWebView?.({ type: 'playbackState', state });
    }

    // Audio reached playing state — clear stuck timer
    if (state === 'playing') {
      errored = false;
      clearStuckTimer();
      // Captured natively because the WebView is suspended in background; it
      // also gives us preload hit-rate without the web app reporting it.
      // Only fires for a track that was just started, so a resume from pause
      // does not report a load. A segment that never reaches playing emits
      // nothing at all, so preload_state here is conditioned on success and
      // reads high — a stall is only visible as a gap in to_index.
      if (pendingStart && pendingStart.index === currentIndex) {
        trackEvent('audio_segment', {
          from_index: pendingStart.fromIndex,
          to_index: pendingStart.index,
          auto_advance: pendingStart.autoAdvance,
          load_ms: Date.now() - pendingStart.at,
          preload_state: pendingStart.preloadState,
          cache_state: pendingStart.cacheState,
          stuck_retried: stuckRetried,
          is_online: isOnline,
          prefetch_depth: prefetch.depth,
          // Segments contiguously warm ahead of the playhead.
          // prefetch_depth is the target; this is what the lookahead achieved,
          // and the only read on whether that depth is sized right.
          warm_runway: Math.max(warmedThroughIndex() - currentIndex, 0),
          tts_session_id: ttsSessionId,
        });
        pendingStart = null;
      }
    }

    // Trigger preload once playback starts
    if (
      state === 'playing' &&
      preload.readyIndex < 0 &&
      preload.loadingIndex < 0 &&
      preload.downloadingIndex < 0
    ) {
      preloadNext();
    }

    // The loop stands itself down whenever state isn't 'playing', so the tick
    // is what brings it back.
    if (state === 'playing') {
      schedulePrefetch();
    }

    // Handle track finish
    if (status.didJustFinish) {
      const now = Date.now();
      if (now - lastFinishTime < 500) return;
      lastFinishTime = now;

      if (currentIndex >= queue.length - 1) {
        // Flush the final stretch and stand the clock down before arming: the
        // review gate refuses to prompt while audio is playing.
        updateListening(false);
        trackEvent('audio_queue_ended', { track_count: queue.length });
        notifyWebView?.({ type: 'queueEnded' });
        // Usually fires with the screen locked, so this parks the prompt for the
        // next foreground rather than showing it to nobody.
        if (sessionListenedMs >= MIN_SESSION_LISTENED_MS) armStoreReview('book_finished');
      } else {
        // Auto-advance natively because WebView JS execution is suspended
        // when the app is backgrounded or the screen is locked, so it
        // cannot respond to an 'ended' event with a 'skipTo' message.
        handleSkipTo(currentIndex + 1, { resetFinishGuard: false });
      }
    }
  }

  // Connectivity for the is_online property on audio events. No seed fetch
  // needed: NetInfo delivers the latest state to a new handler immediately.
  // Guarded like useWebViewRecovery: addEventListener throws when the RNCNetInfo
  // native module is missing, and that must not take the whole bridge down.
  let netInfoSub: (() => void) | null = null;
  try {
    netInfoSub = NetInfo.addEventListener((netState) => {
      isOnline = netState.isConnected !== false;
    });
  } catch {
    // Native module absent — events carry the default rather than crashing.
  }

  const subA = playerA!.addListener('playbackStatusUpdate', (status) => onStatus(playerA!, status));
  const subB = playerB!.addListener('playbackStatusUpdate', (status) => onStatus(playerB!, status));

  // Resume after OS audio interruption (phone call, Siri, other app audio).
  // expo-audio's native handler only resumes when iOS sets shouldResume=true,
  // which doesn't cover all interruption types. We always resume for audiobook
  // playback. Lock screen pause is a remote command (MPRemoteCommandCenter),
  // NOT an interruption, so this does not interfere with user-initiated pause.
  // The `wasPlayingBeforeInterruption` guard prevents resuming if the user had
  // already paused from lock screen before the interruption occurred. We check
  // `lastSentState` (from the player status listener) rather than the JS-only
  // `active` flag, because lock-screen pause goes straight to the native
  // player without calling handlePause().
  let wasPlayingBeforeInterruption = false;
  const interruptionBeganSub = addInterruptionBeganListener(() => {
    wasPlayingBeforeInterruption = lastSentState === 'playing';
  });
  const interruptionEndedSub = addInterruptionEndedListener((_event) => {
    if (wasPlayingBeforeInterruption && active && !errored) {
      // iOS can leave the session deactivated after an interruption; a bare
      // play() then throws "Session activation failed". Re-assert before
      // resuming rather than catching the throw as the other call sites do.
      reassertSession('interruption_resume', null, () => getActivePlayer()?.play());
    }
    wasPlayingBeforeInterruption = false;
  });

  // Re-sync the WebView when the app returns to the foreground.
  // injectJavaScript calls made while the WebView was suspended are dropped,
  // so the web app may have stale track/state info after background playback.
  const appStateSub = AppState.addEventListener('change', (nextAppState) => {
    if (nextAppState === 'active' && currentIndex >= 0) {
      notifyWebView?.({ type: 'trackChanged', index: currentIndex, lastIndex: -1, isResync: true });
      // Same staleness, same fix: every warmedThrough sent while suspended was
      // dropped, so force one out alongside the playhead it is measured from.
      notifyWarmedThrough(true);
      if (lastSentState) {
        notifyWebView?.({ type: 'playbackState', state: lastSentState });
      }
    }
  });

  return () => {
    subA.remove();
    subB.remove();
    netInfoSub?.();
    interruptionBeganSub.remove();
    interruptionEndedSub.remove();
    appStateSub.remove();
    clearStuckTimer();
    resetIdle();
    active = false;
    updateListening(false);
    resetRecoveryState();
    notifyWebView = null;
  };
}
