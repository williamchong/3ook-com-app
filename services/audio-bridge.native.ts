import CookieManager from '@preeternal/react-native-cookie-manager';
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
  type AudioStatus,
} from 'expo-audio';
import { AppState, Platform } from 'react-native';

import type { SendToWebView, BridgeHandlerMap } from './bridge-dispatcher';

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

let playerA: AudioPlayer | null = null;
let playerB: AudioPlayer | null = null;
let activeSlot: 'A' | 'B' = 'A';
const preload = { readyIndex: -1, loadingIndex: -1, resetCount: 0 };
let idleSub: { remove(): void } | null = null;

let queue: QueueTrack[] = [];
let currentIndex = -1;
let currentRate = 1;
let lastFinishTime = 0;
let loadPromise: Promise<void> = Promise.resolve();
let notifyWebView: SendToWebView | null = null;
let lastSentState = '';

// Stuck detection state
// Longer than web player's 5s because iOS uses blocking=1 URLs where the
// server generates the full TTS audio before responding.
const STUCK_TIMEOUT_MS = 15000;
let active = false;
let audible = false;
let stuckTimer: ReturnType<typeof setTimeout> | null = null;
let stuckRetried = false;
let errored = false;

// TODO: Remove this once the blocking param is no longer used in the web app.
// This is to support streaming without breaking older versions of the app.
function stripBlockingParam(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('blocking');
    return u.toString();
  } catch {
    return url;
  }
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
  preload.resetCount += 1;
  idleSub?.remove();
  idleSub = null;
}

function preloadNext(): void {
  const nextIndex = currentIndex + 1;
  if (nextIndex >= queue.length) return;
  if (preload.loadingIndex === nextIndex || preload.readyIndex === nextIndex) return;

  resetIdle();

  const idle = getIdlePlayer();
  if (!idle) return;

  preload.loadingIndex = nextIndex;
  const track = queue[nextIndex];
  idle.pause();
  idle.replace({ uri: track.uri, headers: track.headers });
  idle.setPlaybackRate(currentRate);

  // After a swap the idle player still reports isLoaded from its old track.
  // Wait until we see a buffering/unloaded state (confirming the new source
  // started loading) before accepting isLoaded as the preload being ready.
  // The resetCount guards against stale writes if resetIdle() races
  // with a late-firing status event.
  const startResetCount = preload.resetCount;
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
  if (!playerA) {
    playerA = createAudioPlayer();
  }
  if (!playerB) {
    playerB = createAudioPlayer();
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
  audible = false;
  errored = false;
  stuckRetried = false;
}

function armStuckTimer(): void {
  clearStuckTimer();
  stuckTimer = setTimeout(() => {
    if (audible || !active || stuckRetried || errored) return;
    console.warn('Audio stuck — retrying playback');
    stuckRetried = true;
    const p = getActivePlayer();
    if (!p) return;
    // Non-disruptive retry: just call play() instead of replace(),
    // so we don't nuke a nearly-ready buffer on slow connections.
    p.play();
    stuckTimer = setTimeout(() => {
      stuckTimer = null;
      if (audible || !active || errored) return;
      console.warn('Audio stuck — retry failed');
      errored = true;
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

  lastSentState = 'buffering';
  notifyWebView?.({ type: 'playbackState', state: 'buffering' });

  // Pause before replace so that replaceCurrentSource sees wasPlaying=false
  // and does NOT schedule its own onReady { play() }. Without this, both
  // the internal auto-resume and our explicit play() below race, and
  // addPlaybackEndNotification can register on the wrong AVPlayerItem —
  // causing didJustFinish to never fire.
  p.pause();
  p.replace({ uri: track.uri, headers: track.headers });
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

  // Deactivate old player after new one is active (avoids lock screen gap).
  // We intentionally skip replace(null) — iOS expo-audio throws
  // ConvertingException when casting null to AudioSource. Pause is sufficient
  // since the player will get a new source via replace() on next preload.
  if (oldActive) {
    oldActive.setActiveForLockScreen(false);
  }
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

export function handleLoad(msg: LoadMessage): Promise<void> {
  loadPromise = loadPromise.then(() => doLoad(msg)).catch(() => doLoad(msg));
  return loadPromise;
}

async function doLoad(msg: LoadMessage): Promise<void> {
  await setupPlayer();
  const p = getOrCreatePlayers();

  const cookieUrl = msg.tracks[0]?.url;
  let cookieHeader = '';
  if (cookieUrl) {
    try {
      const cookies = await CookieManager.get(cookieUrl);
      cookieHeader = Object.entries(cookies)
        .map(([name, cookie]) => `${name}=${cookie.value}`)
        .join('; ');
    } catch {
      // Cookies unavailable — proceed without them
    }
  }
  const headers = cookieHeader ? { Cookie: cookieHeader } : undefined;

  if (!msg.tracks.length || msg.startIndex < 0 || msg.startIndex >= msg.tracks.length) return;

  queue = msg.tracks.map((t) => ({
    uri: Platform.OS === 'android' ? stripBlockingParam(t.url) : t.url,
    headers,
    title: t.title || msg.metadata.bookTitle,
    artist: msg.metadata.authorName,
    artworkUrl: msg.metadata.coverUrl,
  }));

  currentIndex = msg.startIndex;
  currentRate = msg.rate;
  lastFinishTime = 0;
  active = true;
  clearStuckTimer();
  resetIdle();

  // Idle player may still be buffering its last preload; pause before new queue
  getIdlePlayer()?.pause();

  notifyWebView?.({ type: 'trackChanged', index: currentIndex, lastIndex: -1 });
  playTrack(p, queue[currentIndex]);
}

export function handlePause(): void {
  active = false;
  audible = false;
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
  active = false;
  resetRecoveryState();
  clearStuckTimer();
  // Skip replace(null) — iOS expo-audio cannot cast null to AudioSource.
  // Pause is enough; players are reused with replace(source) on next load.
  getActivePlayer()?.pause();
  getActivePlayer()?.setActiveForLockScreen(false);
  getIdlePlayer()?.pause();
  getIdlePlayer()?.setActiveForLockScreen(false);
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
  lastFinishTime = 0;

  const lastIndex = currentIndex;
  currentIndex = index;

  if (preload.readyIndex === index) {
    swapToIdle(queue[currentIndex]);
  } else {
    resetIdle();
    playTrack(player, queue[currentIndex]);
  }

  notifyWebView?.({
    type: 'trackChanged',
    index: currentIndex,
    lastIndex,
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
      lastSentState = state;
      notifyWebView?.({ type: 'playbackState', state });
    }

    // NOTE: Do NOT add auto-resume logic here (e.g. detecting unexpected pauses
    // and calling play() after a timeout). expo-audio already handles OS audio
    // interruption recovery natively — iOS via AVAudioSession.interruptionNotification
    // with shouldResume, Android via AUDIOFOCUS_GAIN. A custom auto-resume cannot
    // distinguish lock screen pause (user intent) from OS interruption, causing
    // lock screen pause to be ineffective and the queue to keep advancing.

    // Audio reached playing state — clear stuck timer
    if (state === 'playing') {
      audible = true;
      errored = false;
      clearStuckTimer();
    }

    // Trigger preload once playback starts
    if (state === 'playing' && preload.readyIndex < 0 && preload.loadingIndex < 0) {
      preloadNext();
    }

    // Handle track finish
    if (status.didJustFinish) {
      audible = false;
      const now = Date.now();
      if (now - lastFinishTime < 500) return;
      lastFinishTime = now;

      if (currentIndex >= queue.length - 1) {
        notifyWebView?.({ type: 'queueEnded' });
      } else if (Platform.OS === 'android') {
        // Auto-advance natively on Android because the WebView JS execution
        // is suspended when the screen is locked, so it cannot respond to
        // an 'ended' event with a 'skipTo' message.
        handleSkipTo(currentIndex + 1, { resetFinishGuard: false });
      } else {
        notifyWebView?.({ type: 'ended', index: currentIndex });
      }
    }
  }

  const subA = playerA!.addListener('playbackStatusUpdate', (status) => onStatus(playerA!, status));
  const subB = playerB!.addListener('playbackStatusUpdate', (status) => onStatus(playerB!, status));

  // On Android, re-sync the WebView when the app returns to the foreground.
  // injectJavaScript calls made while the WebView was suspended are dropped,
  // so the web app may have stale track/state info after lock screen playback.
  const appStateSub = Platform.OS === 'android'
    ? AppState.addEventListener('change', (nextAppState) => {
        if (nextAppState === 'active' && currentIndex >= 0) {
          notifyWebView?.({ type: 'trackChanged', index: currentIndex, lastIndex: -1 });
          if (lastSentState) {
            notifyWebView?.({ type: 'playbackState', state: lastSentState });
          }
        }
      })
    : null;

  return () => {
    subA.remove();
    subB.remove();
    appStateSub?.remove();
    clearStuckTimer();
    resetIdle();
    active = false;
    resetRecoveryState();
    notifyWebView = null;
  };
}
