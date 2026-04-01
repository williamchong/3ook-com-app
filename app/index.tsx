import { useEffect, useRef, useCallback } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import * as Application from 'expo-application';

import packageJson from '../package.json';
import {
  setupPlayer,
  handleLoad,
  handlePause,
  handleResume,
  handleStop,
  handleSkipTo,
  handleSetRate,
  handleSeekTo,
  registerEventListeners,
  type LoadMessage,
} from '../services/audio-bridge';
import { isDeepLink, openDeepLink } from '../services/url-bridge';

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

  const sendToWebView = useCallback((data: object) => {
    webViewRef.current?.injectJavaScript(
      `window.dispatchEvent(new CustomEvent('nativeAudioEvent',{detail:${JSON.stringify(data)}}));true;`
    );
  }, []);

  useEffect(() => {
    setupPlayer();
    const unsubscribe = registerEventListeners(sendToWebView);
    return unsubscribe;
  }, [sendToWebView]);

  // Reload WebView when iOS kills its content process in the background.
  const handleContentProcessDidTerminate = useCallback(() => {
    webViewRef.current?.reload();
  }, []);

  // Intercept wallet deep links (wc:, metamask:, etc.) that JS SDKs
  // trigger via navigation rather than postMessage.
  const handleNavigationRequest = useCallback(
    (request: ShouldStartLoadRequest) => {
      if (isDeepLink(request.url)) {
        openDeepLink(request.url).catch((e) =>
          console.warn('[deep link] failed to open:', request.url, e)
        );
        return false;
      }
      return true;
    },
    []
  );

  const handleMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      try {
        const msg: { type: string; [key: string]: unknown } = JSON.parse(
          event.nativeEvent.data
        );

        switch (msg.type) {
          case 'load':
            await handleLoad(msg as unknown as LoadMessage);
            break;
          case 'pause':
            await handlePause();
            break;
          case 'resume':
            await handleResume();
            break;
          case 'stop':
            await handleStop();
            break;
          case 'skipTo':
            if (typeof msg.index === 'number') {
              await handleSkipTo(msg.index);
            }
            break;
          case 'setRate':
            if (typeof msg.rate === 'number') {
              await handleSetRate(msg.rate);
            }
            break;
          case 'seekTo':
            if (typeof msg.position === 'number') {
              await handleSeekTo(msg.position);
            }
            break;
        }
      } catch (e) {
        console.warn('[onMessage]', e);
      }
    },
    []
  );

  return (
    <>
      <View style={{ ...styles.topSpacer, height: insets.top }} />
      <View style={styles.container}>
        <WebView
          ref={webViewRef}
          source={{ uri: 'https://3ook.com?app=1' }}
          originWhitelist={['*']}
          style={styles.webview}
          userAgent={USER_AGENT}
          sharedCookiesEnabled={true}
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback={true}
          pullToRefreshEnabled={true}
          onShouldStartLoadWithRequest={handleNavigationRequest}
          onMessage={handleMessage}
          onContentProcessDidTerminate={handleContentProcessDidTerminate}
          onError={(e) => console.warn('[WebView error]', e.nativeEvent)}
          onHttpError={(e) => console.warn('[WebView HTTP error]', e.nativeEvent)}
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
});
