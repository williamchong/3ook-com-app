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

export async function setupPlayer(): Promise<void> {}
export async function handleLoad(_msg: LoadMessage): Promise<void> {}
export async function handlePause(): Promise<void> {}
export async function handleResume(): Promise<void> {}
export async function handleStop(): Promise<void> {}
export async function handleSkipTo(_index: number): Promise<void> {}
export async function handleSetRate(_rate: number): Promise<void> {}
export async function handleSeekTo(_position: number): Promise<void> {}
export function registerEventListeners(_sendToWebView: (data: object) => void) {
  return () => {};
}
