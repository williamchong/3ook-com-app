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

function getOrCreatePlayer(): AudioPlayer {
  if (!player) {
    player = createAudioPlayer();
  }
  return player;
}

function playTrack(p: AudioPlayer, track: QueueTrack): void {
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
    uri: t.url,
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

export async function handlePause(): Promise<void> {
  player?.pause();
}

export async function handleResume(): Promise<void> {
  player?.play();
}

export async function handleStop(): Promise<void> {
  if (player) {
    player.pause();
    player.setActiveForLockScreen(false);
    player.replace(null);
    currentIndex = -1;
    queue = [];
  }
}

export async function handleSkipTo(index: number): Promise<void> {
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

export async function handleSetRate(rate: number): Promise<void> {
  currentRate = rate;
  player?.setPlaybackRate(rate);
}

export async function handleSeekTo(position: number): Promise<void> {
  await player?.seekTo(position);
}

export function registerEventListeners(sendToWebView: SendToWebView) {
  notifyWebView = sendToWebView;
  const p = getOrCreatePlayer();

  const sub = p.addListener('playbackStatusUpdate', (status) => {
    // Map expo-audio status to RNTP-compatible state strings
    let state: string;
    if (!status.isLoaded) {
      state = 'loading';
    } else if (status.isBuffering) {
      state = 'buffering';
    } else if (status.playing) {
      state = 'playing';
    } else {
      state = 'paused';
    }
    notifyWebView?.({ type: 'playbackState', state });

    // Auto-advance on track finish (debounce for Android duplicate events)
    if (status.didJustFinish) {
      const now = Date.now();
      if (now - lastFinishTime < 500) return;
      lastFinishTime = now;

      const lastIndex = currentIndex;
      if (currentIndex < queue.length - 1) {
        currentIndex++;
        playTrack(p, queue[currentIndex]);
        notifyWebView?.({
          type: 'trackChanged',
          index: currentIndex,
          lastIndex,
        });
      } else {
        notifyWebView?.({
          type: 'queueEnded',
          track: lastIndex,
          position: status.currentTime,
        });
      }
    }
  });

  return () => {
    sub.remove();
    notifyWebView = null;
  };
}
