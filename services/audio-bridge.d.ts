import type { BridgeHandlerMap } from './bridge-dispatcher';

export interface LoadMessage {
  tracks: { index: number; url: string; title?: string }[];
  startIndex: number;
  rate: number;
  metadata: {
    bookTitle: string;
    authorName: string;
    coverUrl: string;
  };
}

export function setupPlayer(): Promise<void>;
export function handleLoad(msg: LoadMessage): Promise<void>;
export function handlePause(): void;
export function handleResume(): void;
export function handleStop(): void;
export function handleSkipTo(index: number): void;
export function handleSetRate(rate: number): void;
export function handleSeekTo(position: number): Promise<void>;
export function getAudioHandlers(): BridgeHandlerMap;
export function registerEventListeners(sendToWebView: (data: object) => void): () => void;
