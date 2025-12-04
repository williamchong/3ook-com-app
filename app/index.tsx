import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

export default function App() {
  const insets = useSafeAreaInsets();
  return (
    <>
      <View style={{ ...styles.topSpacer, height: insets.top }} />
      <View style={{ ...styles.container, paddingBottom: insets.bottom }}>
        <WebView
          source={{ uri: 'https://3ook.com' }}
          originWhitelist={['*']}
          style={styles.webview}
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
