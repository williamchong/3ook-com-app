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
import {
  clearAudioCache,
  ensureCachedAudio,
  evictCachedAudio,
  getCachedAudioUri,
  normalizeUrl,
} from './audio-cache';
import type { SendToWebView, BridgeHandlerMap } from './bridge-dispatcher';
import { armStoreReview, recordListening, setAudioActive } from './store-review';

interface TrackInfo {
  index: number;
  url: string;
  title?: string;
}

export interface LoadMessage {
  tracks: TrackInfo[];
  startIndex: number;
  rate: number;
  metadata: {
    bookTitle: string;
    authorName: string;
    coverUrl: string;
  };
}

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

let playerA: AudioPlayer | null = null;
let playerB: AudioPlayer | null = null;
let activeSlot: 'A' | 'B' = 'A';
// downloadingIndex covers the window before the idle player has the source.
// Deliberately NOT read by handleSkipTo: the idle player still holds the
// previous segment then, so counting it a preload hit would play wrong audio.
const preload = { readyIndex: -1, loadingIndex: -1, downloadingIndex: -1, resetCount: 0 };
let idleSub: { remove(): void } | null = null;

let queue: QueueTrack[] = [];
let currentIndex = -1;
let currentRate = 1;
let lastFinishTime = 0;

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

// Stuck detection state
// Longer than web player's 5s because iOS uses blocking=1 URLs where the
// server generates the full TTS audio before responding.
const STUCK_TIMEOUT_MS = 15000;
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
    }
  });
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
  stuckTimer = setTimeout(() => {
    if (lastSentState === 'playing' || !active || stuckRetried || errored) return;
    console.warn('Audio stuck — retrying playback');
    stuckRetried = true;
    const p = getActivePlayer();
    if (!p) return;
    trackEvent('audio_stuck_retry', {
      current_index: currentIndex,
      // Whether the segment that froze was playing from disk. A cache that
      // serves bad files would show up here as a hit-skewed stall rate.
      cache_state: queue[currentIndex] ? cacheStateFor(queue[currentIndex]) : 'miss',
      is_online: isOnline,
    });
    // Player never buffered (silently-failed source, the common mid-queue
    // stuck case): re-issue the source to force a fresh fetch. If it IS
    // mid-buffer, the bare play() below avoids nuking a nearly-ready buffer.
    const track = queue[currentIndex];
    if (track && !p.isLoaded && !p.isBuffering) {
      // Pause before replace so iOS doesn't schedule its own auto-resume
      // that races the play() below and mis-binds didJustFinish (see playTrack).
      p.pause();
      // Evict any cached copy (it may be corrupt) and stream directly, so the
      // retry cannot replay the same local file that just froze.
      evictCachedAudio(track.uri);
      p.replace(streamSource(track));
      p.setPlaybackRate(currentRate);
    }
    p.play();
    stuckTimer = setTimeout(() => {
      stuckTimer = null;
      if (lastSentState === 'playing' || !active || errored) return;
      console.warn('Audio stuck — retry failed');
      errored = true;
      trackEvent('audio_stuck_failed', { current_index: currentIndex, is_online: isOnline });
      notifyWebView?.({ type: 'error', message: 'Playback stuck' });
    }, STUCK_TIMEOUT_MS);
  }, STUCK_TIMEOUT_MS);
}

function activatePlayer(p: AudioPlayer, track: QueueTrack): void {
  p.setPlaybackRate(currentRate);
  p.setActiveForLockScreen(true, {
    title: track.title,
    artist: track.artist,
    artworkUrl: track.artworkUrl,
  });
  p.play();
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
  active = true;
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
  trackEvent('audio_session_started', {
    track_count: queue.length,
    start_index: currentIndex,
    rate: currentRate,
    is_online: isOnline,
  });
  pendingStart = {
    index: currentIndex,
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
  getActivePlayer()?.play();
}

export function handleStop(): void {
  if (currentIndex >= 0) {
    trackEvent('audio_session_stopped', { last_index: currentIndex });
  }
  active = false;
  updateListening(false);
  resetRecoveryState();
  clearStuckTimer();
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
  pendingStart = { index, at: Date.now(), preloadState, cacheState };

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
  // Captured natively because the WebView is suspended in background; tracking
  // here also gives us preload hit-rate without the web app reporting it.
  trackEvent('audio_track_advanced', {
    from_index: lastIndex,
    to_index: currentIndex,
    preload_state: preloadState,
    auto_advance: !resetFinishGuard,
    // Whether this segment was already on disk when we advanced to it.
    cache_state: cacheState,
    is_online: isOnline,
  });
  preloadNext();
}

export function handleSetRate(rate: number): void {
  currentRate = rate;
  getActivePlayer()?.setPlaybackRate(rate);
  getIdlePlayer()?.setPlaybackRate(rate);
}

export async function handleSeekTo(position: number): Promise<void> {
  await getActivePlayer()?.seekTo(position);
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
    clearNativeCaches: () => clearAudioCache(),
  };
}

export function registerEventListeners(sendToWebView: SendToWebView) {
  notifyWebView = sendToWebView;
  lastSentState = '';
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
      // Only fires for a track that was just started, so a resume from pause
      // does not report a load. A segment that never reaches playing leaves its
      // pendingStart to be overwritten — the missing event is the stall signal.
      if (pendingStart && pendingStart.index === currentIndex) {
        trackEvent('audio_track_playing', {
          index: currentIndex,
          load_ms: Date.now() - pendingStart.at,
          preload_state: pendingStart.preloadState,
          cache_state: pendingStart.cacheState,
          stuck_retried: stuckRetried,
          is_online: isOnline,
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
      // play() then throws "Session activation failed". Wait for any pending
      // release (as doLoad does), re-assert the session, then resume.
      Promise.resolve(sessionReleasePromise)
        .then(() => setIsAudioActiveAsync(true))
        // Re-check: the user may have paused or stopped during the await.
        .then(() => { if (active && !errored) getActivePlayer()?.play(); })
        .catch((e) => console.warn('Interruption resume failed:', e));
    }
    wasPlayingBeforeInterruption = false;
  });

  // Re-sync the WebView when the app returns to the foreground.
  // injectJavaScript calls made while the WebView was suspended are dropped,
  // so the web app may have stale track/state info after background playback.
  const appStateSub = AppState.addEventListener('change', (nextAppState) => {
    if (nextAppState === 'active' && currentIndex >= 0) {
      notifyWebView?.({ type: 'trackChanged', index: currentIndex, lastIndex: -1, isResync: true });
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
