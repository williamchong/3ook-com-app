import CookieManager from '@preeternal/react-native-cookie-manager';
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
  type AudioStatus,
} from 'expo-audio';
import { Platform } from 'react-native';

type SendToWebView = (data: object) => void;

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
}

function swapToIdle(track: QueueTrack): void {
  const oldActive = getActivePlayer();
  // Pause old player first to prevent brief audio overlap during swap
  oldActive?.pause();

  swapSlots();
  activatePlayer(getActivePlayer()!, track);

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
  resetIdle();

  // Idle player may still be buffering its last preload; pause before new queue
  getIdlePlayer()?.pause();

  notifyWebView?.({ type: 'trackChanged', index: currentIndex, lastIndex: -1 });
  playTrack(p, queue[currentIndex]);
}

export function handlePause(): void {
  getActivePlayer()?.pause();
}

export function handleResume(): void {
  getActivePlayer()?.play();
}

export function handleStop(): void {
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

export function handleSkipTo(index: number): void {
  const active = getActivePlayer();
  if (!active || index < 0 || index >= queue.length) return;

  const lastIndex = currentIndex;
  currentIndex = index;

  if (preload.readyIndex === index) {
    swapToIdle(queue[currentIndex]);
  } else {
    resetIdle();
    playTrack(active, queue[currentIndex]);
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

export function registerEventListeners(sendToWebView: SendToWebView) {
  notifyWebView = sendToWebView;
  lastSentState = '';
  getOrCreatePlayers();

  function onStatus(sourcePlayer: AudioPlayer, status: AudioStatus) {
    // Ignore events from the idle player
    if (sourcePlayer !== getActivePlayer()) return;

    // Detect playback errors (AVPlayer status = "failed")
    if (status.playbackState === 'failed') {
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

    // Trigger preload once playback starts
    if (state === 'playing' && preload.readyIndex < 0 && preload.loadingIndex < 0) {
      preloadNext();
    }

    // Notify web app when a track finishes so it can control advancement
    if (status.didJustFinish) {
      const now = Date.now();
      if (now - lastFinishTime < 500) return;
      lastFinishTime = now;

      if (currentIndex >= queue.length - 1) {
        notifyWebView?.({ type: 'queueEnded' });
      } else {
        notifyWebView?.({ type: 'ended', index: currentIndex });
      }
    }
  }

  const subA = playerA!.addListener('playbackStatusUpdate', (status) => onStatus(playerA!, status));
  const subB = playerB!.addListener('playbackStatusUpdate', (status) => onStatus(playerB!, status));

  return () => {
    subA.remove();
    subB.remove();
    resetIdle();
    notifyWebView = null;
  };
}
