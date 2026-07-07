import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WebViewErrorEvent } from 'react-native-webview/lib/WebViewTypes';

import { trackEvent } from '../services/analytics';

// NetInfo reports isConnected as boolean | null; treat null/unknown as online so
// the WebView is never gated offline on an indeterminate signal.
const isStateOnline = (state: NetInfoState) => state.isConnected !== false;

// Cold-start loads of 3ook.com sometimes fail with transient network errors
// (NSURLErrorDomain -1004 cannot-connect-to-host being the most common) before
// the radio/VPN/captive portal has fully settled. Auto-retry by remounting the
// WebView via a key bump, then fall back to a manual retry overlay.
const AUTO_RETRY_DELAYS_MS = [250, 750, 1000, 2500];
const MAX_AUTO_RETRIES = AUTO_RETRY_DELAYS_MS.length;

// WebView load-failure recovery: auto-retry with backoff while online, an
// offline overlay plus reconnect-triggered remount while offline, and a manual
// Retry fallback. `onRemount` runs before each key bump so the caller can
// reset its own per-load state (e.g. the deep-link parked-until-load gate).
export function useWebViewRecovery({ onRemount }: { onRemount: () => void }) {
  const [webViewKey, setWebViewKey] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isRetryInProgress, setIsRetryInProgress] = useState(false);
  // Connectivity drives two things: the Android cacheMode (serve the cached PWA
  // shell when offline so the service worker can boot) and auto-recovery (reload
  // the moment the connection returns instead of stranding the user on a manual
  // Retry button). Mirror to a ref so the error/recovery callbacks read the
  // current value without re-subscribing.
  const [isOnline, setIsOnline] = useState(true);
  const isOnlineRef = useRef(true);
  const retryCountRef = useRef(0);
  const hadLoadFailureRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Seed connectivity before the WebView's first mount: the initial render
  // assumes online (LOAD_DEFAULT), so a cold offline launch would fail on the
  // network before NetInfo reports back. Awaiting this before mounting means
  // the first navigation already uses the offline cache mode on Android.
  // Never rejects; defaults to online if NetInfo is unavailable.
  const seedConnectivity = useCallback(async () => {
    const online = await Promise.resolve()
      .then(() => NetInfo.fetch())
      .then(isStateOnline)
      .catch(() => true);
    isOnlineRef.current = online;
    setIsOnline(online);
  }, []);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const remountWebView = useCallback(() => {
    clearRetryTimer();
    setLoadFailed(false);
    onRemount();
    setWebViewKey((k) => k + 1);
  }, [clearRetryTimer, onRemount]);

  const handleManualRetry = useCallback(() => {
    trackEvent('webview_load_retry', { trigger: 'manual' });
    retryCountRef.current = 0;
    setIsRetryInProgress(true);
    remountWebView();
  }, [remountWebView]);

  // Success-only — onLoadEnd also fires on error (after onError), which would
  // clobber the retry timer we just set. Wire this to onLoad, not onLoadEnd.
  const notifyLoadSucceeded = useCallback(() => {
    if (hadLoadFailureRef.current) {
      trackEvent('webview_load_recovered', { retry_count: retryCountRef.current });
      hadLoadFailureRef.current = false;
    }
    retryCountRef.current = 0;
    clearRetryTimer();
    setLoadFailed(false);
    setIsRetryInProgress(false);
  }, [clearRetryTimer]);

  const handleWebViewError = useCallback(
    (e: WebViewErrorEvent) => {
      const { code, domain, description } = e.nativeEvent;
      // -999 (NSURLErrorCancelled) fires when navigation is preempted, e.g. by
      // onShouldStartLoadWithRequest returning false to hand off to the system
      // browser. Not a real load failure — ignore.
      if (code === -999) return;
      hadLoadFailureRef.current = true;
      const attempt = retryCountRef.current;
      const offline = !isOnlineRef.current;
      trackEvent('webview_load_failed', {
        code,
        domain: domain ?? null,
        description: description ?? null,
        retry_count: attempt,
        offline,
      });
      // Offline: remounting to the network just fails again, and on Android the
      // cached PWA shell was already attempted via cacheMode (LOAD_CACHE_ELSE_
      // NETWORK) on this same load. So skip the auto-retry burst, surface the
      // offline overlay immediately, and let the NetInfo listener auto-recover
      // when the connection returns.
      if (offline) {
        clearRetryTimer();
        retryCountRef.current = 0;
        setIsRetryInProgress(false);
        setLoadFailed(true);
        return;
      }
      if (attempt < MAX_AUTO_RETRIES) {
        const delay = AUTO_RETRY_DELAYS_MS[attempt];
        retryCountRef.current = attempt + 1;
        setIsRetryInProgress(true);
        clearRetryTimer();
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          trackEvent('webview_load_retry', { trigger: 'auto', attempt: attempt + 1 });
          remountWebView();
        }, delay);
      } else {
        clearRetryTimer();
        setIsRetryInProgress(false);
        setLoadFailed(true);
      }
    },
    [clearRetryTimer, remountWebView]
  );

  useEffect(() => {
    return () => {
      clearRetryTimer();
    };
  }, [clearRetryTimer]);

  // Auto-recover when connectivity returns. A cold offline launch lands on the
  // offline overlay (or a cached shell); the moment the radio reconnects, remount
  // for a fresh online load instead of stranding the user on the manual Retry
  // button. Also keeps isOnline/cacheMode in sync for the offline error path.
  useEffect(() => {
    // Guard the subscription: if the RNCNetInfo native module is ever missing
    // (e.g. a JS-only update shipped onto a binary built before this dependency),
    // addEventListener throws — swallow it so the rest of the screen still mounts
    // instead of crashing; the app just loses auto-recovery, not core function.
    try {
      const unsub = NetInfo.addEventListener((state) => {
        const online = isStateOnline(state);
        // NetInfo fires on any network detail change (signal, SSID, cellular
        // subtype); only act on an actual connected/disconnected flip.
        if (online === isOnlineRef.current) return;
        isOnlineRef.current = online;
        setIsOnline(online);
        if (online && hadLoadFailureRef.current) {
          trackEvent('webview_load_retry', { trigger: 'reconnect' });
          retryCountRef.current = 0;
          setIsRetryInProgress(true);
          remountWebView();
        }
      });
      return unsub;
    } catch {
      // Native module absent — skip auto-recovery.
    }
  }, [remountWebView]);

  return {
    isOnline,
    loadFailed,
    isRetryInProgress,
    webViewKey,
    seedConnectivity,
    notifyLoadSucceeded,
    handleWebViewError,
    handleManualRetry,
  };
}
