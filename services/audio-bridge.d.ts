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
export function handlePause(): Promise<void>;
export function handleResume(): Promise<void>;
export function handleStop(): Promise<void>;
export function handleSkipTo(index: number): Promise<void>;
export function handleSetRate(rate: number): Promise<void>;
export function handleSeekTo(position: number): Promise<void>;
export function registerEventListeners(sendToWebView: (data: object) => void): () => void;
