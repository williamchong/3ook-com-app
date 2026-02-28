import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import packageJson from '../package.json';

export default function App() {
  const insets = useSafeAreaInsets();
  return (
    <>
      <View style={{ ...styles.topSpacer, height: insets.top }} />
      <View style={styles.container}>
        <WebView
          source={{ uri: 'https://3ook.com?app=1' }}
          originWhitelist={['*']}
          style={styles.webview}
          userAgent={`3ook-com-app/${packageJson.version}`}
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
