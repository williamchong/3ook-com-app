import CookieManager from '@preeternal/react-native-cookie-manager';
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from 'expo-audio';

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

let player: AudioPlayer | null = null;
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

function getOrCreatePlayer(): AudioPlayer {
  if (!player) {
    player = createAudioPlayer();
  }
  return player;
}

function playTrack(p: AudioPlayer, track: QueueTrack): void {
  // Notify web view immediately so buffering UI shows without waiting
  // for the first async playbackStatusUpdate callback.
  lastSentState = 'buffering';
  notifyWebView?.({ type: 'playbackState', state: 'buffering' });

  // Pause before replace so that replaceCurrentSource sees wasPlaying=false
  // and does NOT schedule its own onReady { play() }. Without this, both
  // the internal auto-resume and our explicit play() below race, and
  // addPlaybackEndNotification can register on the wrong AVPlayerItem —
  // causing didJustFinish to never fire.
  p.pause();
  p.replace({ uri: track.uri, headers: track.headers });
  p.setPlaybackRate(currentRate);
  p.setActiveForLockScreen(true, {
    title: track.title,
    artist: track.artist,
    artworkUrl: track.artworkUrl,
  });
  p.play();
}

let setupDone: Promise<void> | null = null;

export function setupPlayer(): Promise<void> {
  if (!setupDone) {
    setupDone = setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    }).then(() => {
      getOrCreatePlayer();
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
  const p = getOrCreatePlayer();

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

  queue = msg.tracks.map((t) => ({
    uri: stripBlockingParam(t.url),
    headers,
    title: t.title || msg.metadata.bookTitle,
    artist: msg.metadata.authorName,
    artworkUrl: msg.metadata.coverUrl,
  }));

  currentIndex = msg.startIndex;
  currentRate = msg.rate;
  lastFinishTime = 0;

  playTrack(p, queue[currentIndex]);
}

export function handlePause(): void {
  player?.pause();
}

export function handleResume(): void {
  player?.play();
}

export function handleStop(): void {
  if (player) {
    player.pause();
    player.setActiveForLockScreen(false);
    player.replace(null);
    currentIndex = -1;
    queue = [];
    lastSentState = '';
  }
}

export function handleSkipTo(index: number): void {
  if (!player || index < 0 || index >= queue.length) return;

  const lastIndex = currentIndex;
  currentIndex = index;
  playTrack(player, queue[currentIndex]);
  notifyWebView?.({
    type: 'trackChanged',
    index: currentIndex,
    lastIndex,
  });
}

export function handleSetRate(rate: number): void {
  currentRate = rate;
  player?.setPlaybackRate(rate);
}

export async function handleSeekTo(position: number): Promise<void> {
  await player?.seekTo(position);
}

export function registerEventListeners(sendToWebView: SendToWebView) {
  notifyWebView = sendToWebView;
  lastSentState = '';
  const p = getOrCreatePlayer();

  const sub = p.addListener('playbackStatusUpdate', (status) => {
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
  });

  return () => {
    sub.remove();
    notifyWebView = null;
  };
}
