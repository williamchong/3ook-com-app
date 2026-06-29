import * as Application from 'expo-application';
import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { registerSuperProperties, trackEvent } from './analytics';
import type { InstallAttribution } from './install-attribution';

// The Play Install Referrer is one-shot per install, so capture it once and
// persist the parsed result to avoid re-querying on every launch.
const markerFile = new File(Paths.document, 'install-referrer.json');

// Acquisition signals the web/backend consume; click ids ride alongside UTM.
const ATTRIBUTION_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'gclid',
  'fbclid',
  'gad_source',
] as const;

async function readStored(): Promise<InstallAttribution | null> {
  try {
    const data = JSON.parse(await markerFile.text());
    if (data && typeof data.installedAt === 'number' && data.attribution && typeof data.attribution === 'object') {
      return {
        attribution: data.attribution,
        installedAt: data.installedAt,
      };
    }
  } catch {
    // No marker yet, or unreadable — treat as not-captured.
  }
  return null;
}

export async function captureInstallAttribution(): Promise<InstallAttribution | null> {
  // Android-only: iOS has no organic Install Referrer equivalent.
  if (Platform.OS !== 'android') return null;

  // Later launches: return the persisted capture so the bridge re-exposes it.
  const stored = await readStored();
  if (stored) return stored;

  let referrer = '';
  try {
    referrer = await Application.getInstallReferrerAsync();
  } catch (e) {
    console.warn('[install-attribution] getInstallReferrerAsync failed', e);
    // Fall through to persist an empty marker so we don't re-query later.
    referrer = '';
  }

  // Play returns a query-param string ("utm_source=x&utm_medium=y").
  let parsed: Record<string, string> = {};
  try {
    parsed = Object.fromEntries(new URLSearchParams(referrer));
  } catch (e) {
    console.warn('[install-attribution] failed to parse install referrer', e);
  }
  const attribution: Record<string, string> = {};
  for (const key of ATTRIBUTION_KEYS) {
    if (parsed[key]) attribution[key] = parsed[key];
  }
  const result: InstallAttribution = { attribution, installedAt: Date.now() };

  // Persist (even when empty) so we don't re-query on later launches.
  try {
    markerFile.write(JSON.stringify({ ...result, referrer }));
  } catch (e) {
    console.warn('[install-attribution] marker write failed', e);
  }

  if (Object.keys(attribution).length) {
    // Durable on the device so every later native event carries the source.
    registerSuperProperties(attribution);
    trackEvent('install_referrer_captured', { ...attribution, referrer });
  }
  return result;
}
