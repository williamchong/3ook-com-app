export interface InstallAttribution {
  // utm_* / click ids parsed from the Play install referrer (snake_case keys).
  attribution: Record<string, string>;
  // Epoch ms of first capture, for downstream freshness gating (e.g. fbclid).
  installedAt: number;
}

// Captures the Google Play Install Referrer (Android only) on first launch,
// forwards UTM/click-id attribution to analytics, and returns the persisted
// attribution for the webview bridge. Resolves null on iOS and web.
export function captureInstallAttribution(): Promise<InstallAttribution | null>;
