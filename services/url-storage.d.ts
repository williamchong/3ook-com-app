export function saveLastURL(url: string): void;
export function getInitialURL(): Promise<string>;
export function resolveDeepLinkURL(url: string | null | undefined): string | null;
