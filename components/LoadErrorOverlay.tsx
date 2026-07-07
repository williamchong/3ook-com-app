import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

// Single error surface layered over the WebView (its built-in error page is
// suppressed via renderError): a spinner while an auto/manual retry is in
// flight, and an offline/unreachable overlay with a manual Retry button.
export function LoadErrorOverlay({
  isOnline,
  loadFailed,
  isRetryInProgress,
  onRetry,
}: {
  isOnline: boolean;
  loadFailed: boolean;
  isRetryInProgress: boolean;
  onRetry: () => void;
}) {
  if (loadFailed) {
    return (
      <View style={[styles.overlay, styles.errorOverlay]}>
        <Text style={styles.errorTitle}>
          {isOnline ? "Can't reach 3ook.com" : "You're offline"}
        </Text>
        <Text style={styles.errorBody}>
          {isOnline
            ? 'Check your connection and try again.'
            : 'Reconnect to the internet to use 3ook.com.'}
        </Text>
        <Pressable
          onPress={onRetry}
          style={({ pressed }) => [styles.retryButton, pressed && styles.retryButtonPressed]}
          accessibilityRole="button"
          accessibilityLabel="Retry loading"
        >
          <Text style={styles.retryButtonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  if (isRetryInProgress) {
    return (
      <View style={styles.overlay} pointerEvents="none">
        <ActivityIndicator
          size="large"
          color="#131313"
          accessibilityLabel="Loading"
          accessibilityRole="progressbar"
        />
      </View>
    );
  }
  return null;
}

const styles = StyleSheet.create({
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
