// Captures the Google Play Install Referrer (Android only) on first launch and
// forwards the UTM attribution to analytics. No-op on iOS and web.
export function captureInstallAttribution(): Promise<void>;
