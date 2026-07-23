import * as Application from 'expo-application';
import * as Linking from 'expo-linking';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import type {
  ShouldStartLoadRequest,
  WebViewNavigation,
} from 'react-native-webview/lib/WebViewTypes';

import packageJson from '../package.json';
import { LoadErrorOverlay } from '../components/LoadErrorOverlay';
import { useDeepLinkRouting } from '../hooks/useDeepLinkRouting';
import { useWebViewRecovery } from '../hooks/useWebViewRecovery';
import { trackEvent } from '../services/analytics';
import { isAppBoundHost } from '../services/app-bound-domains';
import { isExternalBrowserHost } from '../services/external-hosts';
import {
  getAudioHandlers,
  registerEventListeners,
  setupPlayer,
} from '../services/audio-bridge';
import { initAudioCache } from '../services/audio-cache';
import { clearHandlers, dispatch, registerHandlers } from '../services/bridge-dispatcher';
import { getDownloadHandlers } from '../services/download-bridge';
import { getIdentityHandlers } from '../services/identity-bridge';
import { captureInstallAttribution } from '../services/install-attribution';
import type { InstallAttribution } from '../services/install-attribution';
import {
  configureIAP,
  getIAPHandlers,
  isIAPAvailable,
  wrapIdentityForIAP,
} from '../services/iap-bridge';
import {
  getIntercomHandlers,
  isIntercomAvailable,
  isIntercomPushSupported,
  registerIntercomEventListeners,
  resyncPushStatusToWeb,
  wrapIdentityHandlers,
} from '../services/intercom-bridge';
import {
  getStoreReviewHandlers,
  startStoreReviewWatcher,
} from '../services/store-review';
import { getWebViewCacheHandlers } from '../services/webview-cache-bridge';
import {
  clearWebViewCache,
  isWebViewCacheClearSupported,
} from '../modules/webview-cache';
import { isDeepLink, openDeepLink, openExternalURL } from '../services/url-bridge';
import { getInitialURL, resolveDeepLinkURL, saveLastURL } from '../services/url-storage';

// Appended to (not replacing) the system WebView UA via applicationNameForUserAgent,
// so the real Chromium version stays visible to the web app, server, and analytics.
// The web app parses this token — keep its shape in sync with APP_USER_AGENT_REGEX.
const APP_UA_SUFFIX = (() => {
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
  // RevenueCat in-app purchases; only when a platform API key is configured.
  ...(isIAPAvailable() ? ['iap'] : []),
  // Native App Store / Play rating prompt. Whether it actually appears is up to
  // the store (engagement gate, per-version and yearly quotas), so web should
  // treat requestStoreReview as a hint, never as a guaranteed dialog.
  'storeReview',
  // Native WKWebView cache clear; the web chunk-error plugin's last escalation
  // rung. See modules/webview-cache.
  ...(isWebViewCacheClearSupported() ? ['clearWebViewCache'] : []),
  // Drops app-managed content caches (currently TTS audio); wired to the web's
  // clear-caches flow. Deliberately not gated by the cache kill-switch flag:
  // clearing must work even when the cache is flagged off.
  'clearNativeCaches',
];
const NATIVE_BRIDGE_BOOTSTRAP = `(function(){try{window.__nativeBridge=window.__nativeBridge||{};window.__nativeBridge.features=${JSON.stringify(NATIVE_BRIDGE_FEATURES)};}catch(e){}})();true;`;

export default function App() {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);
  const canGoBackRef = useRef(false);
  const currentURLRef = useRef<string>('');
  const [initialURL, setInitialURL] = useState<string | null>(null);
  // Android install-referrer attribution, persisted natively and re-asserted on
  // the window for the web's getAnalyticsParameters fallback to read.
  const installAttributionRef = useRef<InstallAttribution | null>(null);

  const sendToWebView = useCallback((data: object) => {
    const json = JSON.stringify(data);
    webViewRef.current?.injectJavaScript(
      `window.dispatchEvent(new CustomEvent('nativeAudioEvent',{detail:${json}}));` +
        `window.dispatchEvent(new CustomEvent('nativeBridgeEvent',{detail:${json}}));true;`
    );
  }, []);

  const navigateWebView = useCallback((target: string) => {
    webViewRef.current?.injectJavaScript(
      `window.location.href = ${JSON.stringify(target)};true;`
    );
  }, []);

  const {
    handleNotificationDeepLink,
    markLoadStarted,
    markLoadCompleted,
    isLoaded,
  } = useDeepLinkRouting({ navigateWebView, currentURLRef });

  const {
    isOnline,
    loadFailed,
    isRetryInProgress,
    webViewKey,
    seedConnectivity,
    notifyLoadSucceeded,
    handleWebViewError,
    handleManualRetry,
  } = useWebViewRecovery({
    // Remount resets only the load gate. A deep link parked during a failed
    // cold start intentionally survives the retry remount and flushes on the
    // eventual successful load, not before.
    onRemount: markLoadStarted,
  });

  useEffect(() => {
    // Kick off connectivity resolution in parallel with URL resolution — it's
    // independent of the URL, and we only need it right before the first mount,
    // so overlapping it with the Linking/storage awaits keeps it off the
    // cold-start critical path.
    const connectivityReady = seedConnectivity();
    (async () => {
      const deepLink = await Linking.getInitialURL();
      const resolved = resolveDeepLinkURL(deepLink);
      if (resolved) {
        trackEvent('launched_with_deep_link', {
          source: 'cold_start',
          disposition: 'webview',
        });
      }
      const url = resolved ?? (await getInitialURL());
      currentURLRef.current = url;
      // Await the connectivity seed before the WebView's first mount so a cold
      // offline launch already uses the offline cache mode on Android.
      await connectivityReady;
      setInitialURL(url);
    })();
  }, [seedConnectivity]);

  // Each WebView load lands in a fresh JS context, so re-assert install
  // attribution on every load; the web reads it lazily at checkout time.
  const injectInstallAttribution = useCallback(() => {
    const attr = installAttributionRef.current;
    if (!attr) return;
    webViewRef.current?.injectJavaScript(
      `window.__nativeBridge=window.__nativeBridge||{};` +
        `window.__nativeBridge.installAttribution=${JSON.stringify(attr)};true;`
    );
  }, []);

  // Last-resort recovery for the stale-chunk loop: iOS wipes the SW registration
  // via the native module (which RNCWebView's clearCache can't); Android clears
  // the WebView HTTP cache. markLoadStarted gates injection across the reload.
  const clearWebViewCacheAndReload = useCallback(async () => {
    markLoadStarted();
    try {
      if (Platform.OS === 'ios') {
        await clearWebViewCache();
      } else {
        // clearCache isn't on react-native-webview's exported ref type but is
        // implemented on both platforms' imperative handles.
        (
          webViewRef.current as unknown as {
            clearCache?: (includeDiskFiles: boolean) => void;
          } | null
        )?.clearCache?.(true);
      }
    } catch (e) {
      console.warn('[webview-cache] clear failed', e);
    }
    webViewRef.current?.reload();
  }, [markLoadStarted]);

  useEffect(() => {
    configureIAP();
    captureInstallAttribution().then((attr) => {
      if (!attr || (!Object.keys(attr.attribution).length && !attr.affiliateFrom)) return;
      installAttributionRef.current = attr;
      if (isLoaded()) injectInstallAttribution();
    });
    registerHandlers(getAudioHandlers());
    registerHandlers(getDownloadHandlers());
    registerHandlers(getIntercomHandlers(sendToWebView));
    registerHandlers(getIAPHandlers(sendToWebView));
    registerHandlers(getStoreReviewHandlers());
    registerHandlers(getWebViewCacheHandlers(clearWebViewCacheAndReload));
    // identifyUser/resetUser fan out to analytics (base), RevenueCat logIn/Out
    // (IAP wrap), then Intercom (outer wrap) — one identity event, three sinks.
    registerHandlers(
      wrapIdentityHandlers(wrapIdentityForIAP(getIdentityHandlers()), sendToWebView)
    );

    setupPlayer();
    initAudioCache();
    const unsubscribeAudio = registerEventListeners(sendToWebView);
    const unsubscribeIntercom = registerIntercomEventListeners(
      sendToWebView,
      handleNotificationDeepLink
    );
    const unsubscribeStoreReview = startStoreReviewWatcher();
    return () => {
      unsubscribeAudio();
      unsubscribeIntercom();
      unsubscribeStoreReview();
      clearHandlers();
    };
  }, [
    sendToWebView,
    handleNotificationDeepLink,
    injectInstallAttribution,
    isLoaded,
    clearWebViewCacheAndReload,
  ]);

  // Reload WebView when iOS kills its content process in the background.
  const handleContentProcessDidTerminate = useCallback(() => {
    trackEvent('webview_content_terminated');
    // reload() also triggers onLoadStart → markLoadStarted, but that fires
    // async: a tap landing between this call and onLoadStart would inject into
    // the now-dead JS context. Gate synchronously here to close that window.
    markLoadStarted();
    webViewRef.current?.reload();
  }, [markLoadStarted]);

  // Success-only load handler (see notifyLoadSucceeded for why not onLoadEnd).
  // Inject attribution before markLoadCompleted flushes any parked navigation.
  const handleLoad = useCallback(() => {
    notifyLoadSucceeded();
    injectInstallAttribution();
    markLoadCompleted();
  }, [notifyLoadSucceeded, injectInstallAttribution, markLoadCompleted]);

  // Each WebView load lands in a fresh JS context with no memory of prior
  // dispatches; re-emit native state that web listeners want at boot.
  const handleLoadEnd = useCallback(() => {
    if (isIntercomPushSupported()) {
      resyncPushStatusToWeb(sendToWebView);
    }
  }, [sendToWebView]);

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
        // Browser-only 3ook subdomains (e.g. docs.3ook.com) would be kept in-app
        // by isAppBoundHost and trap the user; let them fall through to external.
        if (isAppBoundHost(parsed.hostname) && !isExternalBrowserHost(parsed.hostname))
          return true;
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
            applicationNameForUserAgent={APP_UA_SUFFIX}
            sharedCookiesEnabled={true}
            mediaPlaybackRequiresUserAction={false}
            allowsInlineMediaPlayback={true}
            pullToRefreshEnabled={true}
            allowsBackForwardNavigationGestures={true}
            limitsNavigationsToAppBoundDomains={Platform.OS === 'ios'}
            // Android only: when offline, serve the last-cached shell (even if
            // expired) so the PWA's service worker can boot and render its
            // offline content. Stays LOAD_DEFAULT while online so fresh loads
            // are never served stale. iOS ignores this and relies on its SW.
            cacheMode={!isOnline ? 'LOAD_CACHE_ELSE_NETWORK' : 'LOAD_DEFAULT'}
            // Suppress react-native-webview's built-in error page (the raw
            // "Error loading page / net::ERR_INTERNET_DISCONNECTED" Chromium
            // screen on Android, blank on iOS). LoadErrorOverlay is the single
            // error surface; render a matching-color blank so there's no flash.
            renderError={() => <View style={styles.errorFallback} />}
            webviewDebuggingEnabled={__DEV__}
            injectedJavaScriptBeforeContentLoaded={NATIVE_BRIDGE_BOOTSTRAP}
            onShouldStartLoadWithRequest={handleNavigationRequest}
            onNavigationStateChange={handleNavigationStateChange}
            onMessage={handleMessage}
            onLoadStart={markLoadStarted}
            onLoad={handleLoad}
            onLoadEnd={handleLoadEnd}
            onContentProcessDidTerminate={handleContentProcessDidTerminate}
            onError={handleWebViewError}
            onHttpError={(e) => console.warn('[WebView HTTP error]', e.nativeEvent)}
          />
        )}
        <LoadErrorOverlay
          isOnline={isOnline}
          loadFailed={loadFailed}
          isRetryInProgress={isRetryInProgress}
          onRetry={handleManualRetry}
        />
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
  errorFallback: {
    flex: 1,
    backgroundColor: '#f9f9f9',
  },
});
