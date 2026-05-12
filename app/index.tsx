import * as Application from 'expo-application';
import * as Linking from 'expo-linking';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import type {
  ShouldStartLoadRequest,
  WebViewErrorEvent,
  WebViewNavigation,
} from 'react-native-webview/lib/WebViewTypes';

import packageJson from '../package.json';
import { trackEvent } from '../services/analytics';
import { isAppBoundHost } from '../services/app-bound-domains';
import {
  getAudioHandlers,
  registerEventListeners,
  setupPlayer,
} from '../services/audio-bridge';
import { clearHandlers, dispatch, registerHandlers } from '../services/bridge-dispatcher';
import { getDownloadHandlers } from '../services/download-bridge';
import { getIdentityHandlers } from '../services/identity-bridge';
import {
  getIntercomHandlers,
  isIntercomAvailable,
  isIntercomPushSupported,
  registerIntercomEventListeners,
  resyncPushStatusToWeb,
  wrapIdentityHandlers,
} from '../services/intercom-bridge';
import { isDeepLink, openDeepLink, openExternalURL } from '../services/url-bridge';
import { getInitialURL, resolveDeepLinkURL, saveLastURL } from '../services/url-storage';

// e.g. 3ook-com-app/1.1.0 (iOS 18.0) Build/42
const USER_AGENT = (() => {
  const appVersion = Application.nativeApplicationVersion ?? packageJson.version;
  const buildNumber = Application.nativeBuildVersion;
  const buildToken = buildNumber ? ` Build/${buildNumber}` : '';
  const osName = Platform.OS === 'ios' ? 'iOS' : 'Android';
  return `3ook-com-app/${appVersion} (${osName} ${Platform.Version})${buildToken}`;
})();

// Capability advertisement so web can detect what this build supports without
// pinning to a build number. Add a string here when introducing a new
// bridge that web should be able to feature-detect.
const NATIVE_BRIDGE_FEATURES: readonly string[] = [
  ...(isIntercomAvailable() ? ['intercom'] : []),
  // Push is currently routed through the Intercom handler (`requestPushPermission`,
  // `pushPermissionChanged`); advertise only when both are usable.
  ...(isIntercomPushSupported() ? ['intercomPush'] : []),
];
const NATIVE_BRIDGE_BOOTSTRAP = `(function(){try{window.__nativeBridge=window.__nativeBridge||{};window.__nativeBridge.features=${JSON.stringify(NATIVE_BRIDGE_FEATURES)};}catch(e){}})();true;`;

// Cold-start loads of 3ook.com sometimes fail with transient network errors
// (NSURLErrorDomain -1004 cannot-connect-to-host being the most common) before
// the radio/VPN/captive portal has fully settled. Auto-retry by remounting the
// WebView via a key bump, then fall back to a manual retry overlay.
const AUTO_RETRY_DELAYS_MS = [1000, 2500];
const MAX_AUTO_RETRIES = AUTO_RETRY_DELAYS_MS.length;
// Delay before revealing the spinner so fast recoveries don't flash UI.
const SPINNER_REVEAL_DELAY_MS = 500;

export default function App() {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);
  const canGoBackRef = useRef(false);
  const currentURLRef = useRef<string>('');
  const [initialURL, setInitialURL] = useState<string | null>(null);
  const [webViewKey, setWebViewKey] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isRetryInProgress, setIsRetryInProgress] = useState(false);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spinnerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      const deepLink = await Linking.getInitialURL();
      const resolved = resolveDeepLinkURL(deepLink);
      if (resolved) {
        trackEvent('launched_with_deep_link', { source: 'cold_start' });
      }
      const url = resolved ?? (await getInitialURL());
      currentURLRef.current = url;
      setInitialURL(url);
    })();
  }, []);

  useEffect(() => {
    const sub = Linking.addEventListener('url', ({ url }) => {
      const target = resolveDeepLinkURL(url);
      if (!target || target === currentURLRef.current) return;
      trackEvent('launched_with_deep_link', { source: 'warm' });
      currentURLRef.current = target;
      webViewRef.current?.injectJavaScript(
        `window.location.href = ${JSON.stringify(target)};true;`
      );
    });
    return () => sub.remove();
  }, []);

  const sendToWebView = useCallback((data: object) => {
    const json = JSON.stringify(data);
    webViewRef.current?.injectJavaScript(
      `window.dispatchEvent(new CustomEvent('nativeAudioEvent',{detail:${json}}));` +
        `window.dispatchEvent(new CustomEvent('nativeBridgeEvent',{detail:${json}}));true;`
    );
  }, []);

  useEffect(() => {
    registerHandlers(getAudioHandlers());
    registerHandlers(getDownloadHandlers());
    registerHandlers(getIntercomHandlers(sendToWebView));
    registerHandlers(wrapIdentityHandlers(getIdentityHandlers(), sendToWebView));

    setupPlayer();
    const unsubscribeAudio = registerEventListeners(sendToWebView);
    const unsubscribeIntercom = registerIntercomEventListeners(sendToWebView);
    return () => {
      unsubscribeAudio();
      unsubscribeIntercom();
      clearHandlers();
    };
  }, [sendToWebView]);

  // Reload WebView when iOS kills its content process in the background.
  const handleContentProcessDidTerminate = useCallback(() => {
    trackEvent('webview_content_terminated');
    webViewRef.current?.reload();
  }, []);

  const clearSpinnerTimer = useCallback(() => {
    if (spinnerTimerRef.current) {
      clearTimeout(spinnerTimerRef.current);
      spinnerTimerRef.current = null;
    }
  }, []);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const scheduleSpinnerReveal = useCallback(() => {
    if (spinnerTimerRef.current) return;
    spinnerTimerRef.current = setTimeout(() => {
      spinnerTimerRef.current = null;
      setIsRetryInProgress(true);
    }, SPINNER_REVEAL_DELAY_MS);
  }, []);

  // Success-only — onLoadEnd also fires on error (after onError), which would
  // clobber the retry timer we just set. Use onLoad for the success path.
  const handleLoad = useCallback(() => {
    retryCountRef.current = 0;
    clearRetryTimer();
    clearSpinnerTimer();
    setLoadFailed(false);
    setIsRetryInProgress(false);
  }, [clearRetryTimer, clearSpinnerTimer]);

  // Each WebView load lands in a fresh JS context with no memory of prior
  // dispatches; re-emit native state that web listeners want at boot.
  const handleLoadEnd = useCallback(() => {
    if (isIntercomPushSupported()) {
      resyncPushStatusToWeb(sendToWebView);
    }
  }, [sendToWebView]);

  const remountWebView = useCallback(() => {
    clearRetryTimer();
    setLoadFailed(false);
    setWebViewKey((k) => k + 1);
  }, [clearRetryTimer]);

  const handleManualRetry = useCallback(() => {
    trackEvent('webview_load_retry', { trigger: 'manual' });
    retryCountRef.current = 0;
    scheduleSpinnerReveal();
    remountWebView();
  }, [remountWebView, scheduleSpinnerReveal]);

  const handleWebViewError = useCallback(
    (e: WebViewErrorEvent) => {
      const { code, domain, description } = e.nativeEvent;
      // -999 (NSURLErrorCancelled) fires when navigation is preempted, e.g. by
      // onShouldStartLoadWithRequest returning false to hand off to the system
      // browser. Not a real load failure — ignore.
      if (code === -999) return;
      const attempt = retryCountRef.current;
      trackEvent('webview_load_failed', {
        code,
        domain: domain ?? null,
        description: description ?? null,
        retry_count: attempt,
      });
      if (attempt < MAX_AUTO_RETRIES) {
        const delay = AUTO_RETRY_DELAYS_MS[attempt];
        retryCountRef.current = attempt + 1;
        scheduleSpinnerReveal();
        clearRetryTimer();
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          trackEvent('webview_load_retry', { trigger: 'auto', attempt: attempt + 1 });
          remountWebView();
        }, delay);
      } else {
        clearSpinnerTimer();
        clearRetryTimer();
        setIsRetryInProgress(false);
        setLoadFailed(true);
      }
    },
    [clearRetryTimer, clearSpinnerTimer, remountWebView, scheduleSpinnerReveal]
  );

  useEffect(() => {
    return () => {
      clearRetryTimer();
      clearSpinnerTimer();
    };
  }, [clearRetryTimer, clearSpinnerTimer]);

  // Intercept wallet deep links (wc:, metamask:, etc.) and route non-app-bound
  // top-frame navigations to the system browser — WebKit's app-bound enforcement
  // would otherwise silently block them.
  const handleNavigationRequest = useCallback(
    (request: ShouldStartLoadRequest) => {
      if (isDeepLink(request.url)) {
        // Don't capture full URL — wallet links can carry session tokens or
        // user data. Scheme/host is enough to attribute the route.
        let scheme = 'unknown';
        let host: string | null = null;
        try {
          const parsed = new URL(request.url);
          scheme = parsed.protocol.replace(':', '');
          host = parsed.hostname || null;
        } catch {
          // Custom schemes (wc:, metamask:) may not parse — fall back to prefix.
          scheme = request.url.split(':')[0] || 'unknown';
        }
        trackEvent('deep_link_opened', { scheme, host });
        openDeepLink(request.url).catch((e) =>
          console.warn('[deep link] failed to open:', request.url, e)
        );
        return false;
      }
      // Leave iframes to WebKit; non-app-bound iframe loads (e.g. Stripe's
      // metrics iframe) get silently blocked there, which is intended.
      if (request.isTopFrame === false) return true;
      try {
        const parsed = new URL(request.url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return true;
        if (isAppBoundHost(parsed.hostname)) return true;
        trackEvent('external_url_opened', { host: parsed.hostname });
        openExternalURL(request.url).catch((e) =>
          console.warn('[external link] failed to open:', request.url, e)
        );
        return false;
      } catch {
        return true;
      }
    },
    []
  );

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleNavigationStateChange = useCallback(
    (navState: WebViewNavigation) => {
      canGoBackRef.current = navState.canGoBack;
      if (!navState.url) return;
      const resolvedURL = resolveDeepLinkURL(navState.url) ?? navState.url;
      currentURLRef.current = resolvedURL;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => saveLastURL(resolvedURL), 1500);
    },
    []
  );
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBackRef.current) {
        webViewRef.current?.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, []);

  const handleMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      try {
        await dispatch(event.nativeEvent.data);
      } catch (e) {
        console.warn('[onMessage]', e);
      }
    },
    []
  );

  return (
    <>
      <View style={[styles.topSpacer, { height: insets.top }]} />
      <View style={styles.container}>
        {initialURL && (
          <WebView
            key={webViewKey}
            ref={webViewRef}
            source={{ uri: initialURL }}
            originWhitelist={['*']}
            style={styles.webview}
            userAgent={USER_AGENT}
            sharedCookiesEnabled={true}
            mediaPlaybackRequiresUserAction={false}
            allowsInlineMediaPlayback={true}
            pullToRefreshEnabled={true}
            allowsBackForwardNavigationGestures={true}
            limitsNavigationsToAppBoundDomains={Platform.OS === 'ios'}
            webviewDebuggingEnabled={__DEV__}
            injectedJavaScriptBeforeContentLoaded={NATIVE_BRIDGE_BOOTSTRAP}
            onShouldStartLoadWithRequest={handleNavigationRequest}
            onNavigationStateChange={handleNavigationStateChange}
            onMessage={handleMessage}
            onLoad={handleLoad}
            onLoadEnd={handleLoadEnd}
            onContentProcessDidTerminate={handleContentProcessDidTerminate}
            onError={handleWebViewError}
            onHttpError={(e) => console.warn('[WebView HTTP error]', e.nativeEvent)}
          />
        )}
        {isRetryInProgress && !loadFailed && (
          <View style={styles.overlay} pointerEvents="none">
            <ActivityIndicator
              size="large"
              color="#131313"
              accessibilityLabel="Loading"
              accessibilityRole="progressbar"
            />
          </View>
        )}
        {loadFailed && (
          <View style={[styles.overlay, styles.errorOverlay]}>
            <Text style={styles.errorTitle}>Can&apos;t reach 3ook.com</Text>
            <Text style={styles.errorBody}>Check your connection and try again.</Text>
            <Pressable
              onPress={handleManualRetry}
              style={({ pressed }) => [styles.retryButton, pressed && styles.retryButtonPressed]}
              accessibilityRole="button"
              accessibilityLabel="Retry loading"
            >
              <Text style={styles.retryButtonText}>Retry</Text>
            </Pressable>
          </View>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  topSpacer: {
    backgroundColor: '#131313',
  },
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  webview: {
    flex: 1,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f9f9f9',
  },
  errorOverlay: {
    paddingHorizontal: 32,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#131313',
    marginBottom: 8,
    textAlign: 'center',
  },
  errorBody: {
    fontSize: 14,
    color: '#5b5b5b',
    marginBottom: 24,
    textAlign: 'center',
  },
  retryButton: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
    backgroundColor: '#131313',
  },
  retryButtonPressed: {
    opacity: 0.7,
  },
  retryButtonText: {
    color: '#f9f9f9',
    fontSize: 15,
    fontWeight: '600',
  },
});
