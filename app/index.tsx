import { useEffect, useRef, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';

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

  const handleMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      let msg: { type: string; [key: string]: unknown };
      try {
        msg = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }

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
          await handleSetRate(msg.rate as number);
          break;
        case 'seekTo':
          await handleSeekTo(msg.position as number);
          break;
      }
    },
    []
  );

  return (
    <>
      <View style={{ ...styles.topSpacer, height: insets.top }} />
      <View style={{ ...styles.container, paddingBottom: insets.bottom }}>
        <WebView
          ref={webViewRef}
          source={{ uri: 'https://3ook.com?app=1' }}
          originWhitelist={['*']}
          style={styles.webview}
          userAgent={`3ook-com-app/${packageJson.version}`}
          sharedCookiesEnabled={true}
          onMessage={handleMessage}
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
