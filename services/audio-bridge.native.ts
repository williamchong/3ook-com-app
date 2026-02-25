import TrackPlayer, {
  Capability,
  Event,
  type PlaybackActiveTrackChangedEvent,
  type PlaybackErrorEvent,
  type PlaybackQueueEndedEvent,
  type PlaybackState,
} from 'react-native-track-player';

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

let isPlayerSetup = false;

export async function setupPlayer(): Promise<void> {
  if (isPlayerSetup) return;
  await TrackPlayer.setupPlayer();
  await TrackPlayer.updateOptions({
    capabilities: [
      Capability.Play,
      Capability.Pause,
      Capability.SkipToNext,
      Capability.SkipToPrevious,
    ],
  });
  isPlayerSetup = true;
}

export async function handleLoad(msg: LoadMessage): Promise<void> {
  await setupPlayer();
  await TrackPlayer.reset();
  const tracks = msg.tracks.map((t) => ({
    id: String(t.index),
    url: t.url,
    title: t.title || msg.metadata.bookTitle,
    artist: msg.metadata.authorName,
    artwork: msg.metadata.coverUrl,
  }));
  await TrackPlayer.add(tracks);
  if (msg.startIndex > 0) {
    await TrackPlayer.skip(msg.startIndex);
  }
  await TrackPlayer.setRate(msg.rate);
  await TrackPlayer.play();
}

export async function handlePause(): Promise<void> {
  await TrackPlayer.pause();
}

export async function handleResume(): Promise<void> {
  await TrackPlayer.play();
}

export async function handleStop(): Promise<void> {
  await TrackPlayer.reset();
}

export async function handleSkipTo(index: number): Promise<void> {
  await TrackPlayer.skip(index);
}

export async function handleSetRate(rate: number): Promise<void> {
  await TrackPlayer.setRate(rate);
}

export async function handleSeekTo(position: number): Promise<void> {
  await TrackPlayer.seekTo(position);
}

export function registerPlaybackService() {
  TrackPlayer.registerPlaybackService(() => async () => {
    TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
    TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
    TrackPlayer.addEventListener(Event.RemoteNext, () => TrackPlayer.skipToNext());
    TrackPlayer.addEventListener(Event.RemotePrevious, () => TrackPlayer.skipToPrevious());
  });
}

export function registerEventListeners(sendToWebView: SendToWebView) {
  const subs = [
    TrackPlayer.addEventListener(
      Event.PlaybackActiveTrackChanged,
      (event: PlaybackActiveTrackChangedEvent) => {
        if (typeof event.index !== 'number') return;
        sendToWebView({
          type: 'trackChanged',
          index: event.index,
          lastIndex: event.lastIndex,
        });
      }
    ),
    TrackPlayer.addEventListener(
      Event.PlaybackQueueEnded,
      (event: PlaybackQueueEndedEvent) => {
        sendToWebView({
          type: 'queueEnded',
          track: event.track,
          position: event.position,
        });
      }
    ),
    TrackPlayer.addEventListener(
      Event.PlaybackState,
      (event: PlaybackState) => {
        sendToWebView({
          type: 'playbackState',
          state: event.state,
        });
      }
    ),
    TrackPlayer.addEventListener(
      Event.PlaybackError,
      (event: PlaybackErrorEvent) => {
        sendToWebView({
          type: 'error',
          message: event.message,
          code: event.code,
        });
      }
    ),
  ];

  return () => subs.forEach((s) => s.remove());
}
