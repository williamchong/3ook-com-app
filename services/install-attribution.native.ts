import * as Application from 'expo-application';
import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { registerSuperProperties, trackEvent } from './analytics';

// The Play Install Referrer is one-shot per install, so capture it once and
// persist a marker to avoid re-querying on every launch.
const markerFile = new File(Paths.document, 'install-referrer.json');

const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const;

export async function captureInstallAttribution(): Promise<void> {
  // Android-only: iOS has no organic Install Referrer equivalent.
  if (Platform.OS !== 'android') return;
  if (markerFile.exists) return;

  let referrer = '';
  try {
    referrer = await Application.getInstallReferrerAsync();
  } catch (e) {
    console.warn('[install-attribution] getInstallReferrerAsync failed', e);
    // Fall through to write the marker so we don't re-query on later launches.
    referrer = '';
  }

  // Mark handled regardless of outcome so we don't re-query on later launches.
  try {
    markerFile.write(JSON.stringify({ referrer, timestamp: Date.now() }));
  } catch (e) {
    console.warn('[install-attribution] marker write failed', e);
  }

  if (!referrer) return;

  // Play returns a query-param string ("utm_source=x&utm_medium=y").
  let parsed: Record<string, string>;
  try {
    parsed = Object.fromEntries(new URLSearchParams(referrer));
  } catch (e) {
    console.warn('[install-attribution] failed to parse install referrer', e);
    return;
  }
  const attribution: Record<string, string> = { referrer };
  for (const key of UTM_KEYS) {
    if (parsed[key]) attribution[key] = parsed[key];
  }

  // Durable on the device so every later event carries the acquisition source.
  registerSuperProperties(attribution);
  trackEvent('install_referrer_captured', attribution);
}
