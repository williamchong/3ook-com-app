import * as Application from 'expo-application';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import type {
  ShouldStartLoadRequest,
  WebViewNavigation,
} from 'react-native-webview/lib/WebViewTypes';

import packageJson from '../package.json';
import { isAppBoundHost } from '../services/app-bound-domains';
import {
  getAudioHandlers,
  registerEventListeners,
  setupPlayer,
} from '../services/audio-bridge';
import { clearHandlers, dispatch, registerHandlers } from '../services/bridge-dispatcher';
import { getDownloadHandlers } from '../services/download-bridge';
import { getIdentityHandlers } from '../services/identity-bridge';
import { posthog } from '../services/posthog';
import { isDeepLink, openDeepLink, openExternalURL } from '../services/url-bridge';
import { getInitialURL, saveLastURL } from '../services/url-storage';

// e.g. 3ook-com-app/1.1.0 (iOS 18.0) Build/42
const USER_AGENT = (() => {
  const appVersion = Application.nativeApplicationVersion ?? packageJson.version;
  const buildNumber = Application.nativeBuildVersion;
  const buildToken = buildNumber ? ` Build/${buildNumber}` : '';
  const osName = Platform.OS === 'ios' ? 'iOS' : 'Android';
  return `3ook-com-app/${appVersion} (${osName} ${Platform.Version})${buildToken}`;
})();

export default function App() {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);
  const canGoBackRef = useRef(false);
  const [initialURL, setInitialURL] = useState<string | null>(null);

  useEffect(() => {
    getInitialURL().then(setInitialURL);
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
    registerHandlers(getIdentityHandlers(posthog));

    setupPlayer();
    const unsubscribe = registerEventListeners(sendToWebView);
    return () => {
      unsubscribe();
      clearHandlers();
    };
  }, [sendToWebView]);

  // Reload WebView when iOS kills its content process in the background.
  const handleContentProcessDidTerminate = useCallback(() => {
    webViewRef.current?.reload();
  }, []);

  // Intercept wallet deep links (wc:, metamask:, etc.) and route non-app-bound
  // top-frame navigations to the system browser — WebKit's app-bound enforcement
  // would otherwise silently block them.
  const handleNavigationRequest = useCallback(
    (request: ShouldStartLoadRequest) => {
      if (isDeepLink(request.url)) {
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
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => saveLastURL(navState.url), 1500);
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
            onShouldStartLoadWithRequest={handleNavigationRequest}
            onNavigationStateChange={handleNavigationStateChange}
            onMessage={handleMessage}
            onContentProcessDidTerminate={handleContentProcessDidTerminate}
            onError={(e) => console.warn('[WebView error]', e.nativeEvent)}
            onHttpError={(e) => console.warn('[WebView HTTP error]', e.nativeEvent)}
          />
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
});
