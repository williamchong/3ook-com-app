import analytics from '@react-native-firebase/analytics';
import crashlytics from '@react-native-firebase/crashlytics';

import { posthog } from './posthog';

import type {
  AnalyticsIdentifyTraits,
  AnalyticsProperties,
  AnalyticsValue,
} from './analytics';

// Web also captures into the same PostHog/Firebase projects. Prefix every
// native shell event so a `push_permission_changed` from the web Push API
// doesn't collide with one from the iOS/Android shell. Callers must pass
// bare names — the prefix is applied unconditionally so a doubled
// `app_app_foo` surfaces typos instead of silently coalescing.
const NATIVE_EVENT_PREFIX = 'app_';

// Firebase Analytics rejects boolean values and silently drops null/undefined,
// so coerce booleans to strings and strip nullish keys before forwarding.
// PostHog accepts arbitrary objects and gets the raw shape.
function toFirebaseParams(
  props: AnalyticsProperties | undefined,
): Record<string, string | number> | undefined {
  if (!props) return undefined;
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(props) as [string, AnalyticsValue][]) {
    if (value === null || value === undefined) continue;
    out[key] = typeof value === 'boolean' ? (value ? 'true' : 'false') : value;
  }
  return Object.keys(out).length ? out : undefined;
}

export function trackEvent(event: string, properties?: AnalyticsProperties): void {
  const name = `${NATIVE_EVENT_PREFIX}${event}`;
  try {
    // AnalyticsValue is a JSON-compatible union; cast through unknown to
    // satisfy posthog-react-native's stricter PostHogEventProperties type.
    posthog.capture(name, properties as unknown as Record<string, string | number | boolean | null>);
  } catch (e) {
    console.warn('[analytics] posthog.capture failed', e);
  }
  analytics()
    .logEvent(name, toFirebaseParams(properties))
    .catch((e) => console.warn('[analytics] firebase logEvent failed', e));
}

// Attach durable properties (e.g. install attribution) to every subsequent
// PostHog event on this device. Firebase collects install attribution natively
// via GA4, so this targets PostHog only.
export function registerSuperProperties(properties: AnalyticsProperties): void {
  try {
    // Cast through unknown for posthog-react-native's stricter type, as trackEvent does.
    posthog.register(properties as unknown as Record<string, string | number | boolean | null>);
  } catch (e) {
    console.warn('[analytics] posthog.register failed', e);
  }
}

export async function identify(
  userId: string,
  traits: AnalyticsIdentifyTraits,
): Promise<void> {
  const { email, displayName, isLikerPlus, likerPlusTier, loginMethod, locale, gaUserId } = traits;

  try {
    posthog.identify(userId, {
      email: email ?? null,
      name: displayName ?? null,
      is_liker_plus: !!isLikerPlus,
      liker_plus_tier: likerPlusTier ?? null,
      login_method: loginMethod ?? null,
      locale: locale ?? null,
    });
  } catch (e) {
    console.warn('[analytics] posthog.identify failed', e);
  }

  const userProps = {
    is_liker_plus: String(!!isLikerPlus),
    liker_plus_tier: likerPlusTier ?? '',
    login_method: loginMethod ?? '',
    locale: locale ?? '',
  };

  const fa = analytics();
  const cl = crashlytics();
  const tasks: Promise<unknown>[] = [
    fa.setUserProperties(userProps),
    cl.setUserId(userId),
    cl.setAttributes(userProps),
  ];
  if (gaUserId) tasks.push(fa.setUserId(gaUserId));
  await Promise.all(tasks);
}

// Watch a boolean feature flag. PostHog persists the last flags response, so on
// any launch after the first the seed read already has the real value; on a
// cold install it is undefined until the network response lands.
export function watchFeatureFlag(
  key: string,
  onChange: (enabled: boolean | undefined) => void,
): void {
  // Subscribe before seeding: if the seed read throws, the caller must still
  // get later updates, or a kill-switch would be dead for the whole process.
  // Re-read inside the callback rather than using its argument — onFeatureFlag
  // reports the raw flag (string for multivariate), isFeatureEnabled coerces.
  try {
    posthog.onFeatureFlag(key, () => onChange(posthog.isFeatureEnabled(key)));
  } catch (e) {
    console.warn('[analytics] watchFeatureFlag subscribe failed', e);
  }
  try {
    // onFeatureFlag only fires on a reload, never with the current value.
    onChange(posthog.isFeatureEnabled(key));
  } catch (e) {
    console.warn('[analytics] watchFeatureFlag seed failed', e);
  }
}

// Firebase App Instance ID. Exposed so the IAP bridge can mirror it onto
// RevenueCat's reserved $firebaseAppInstanceId attribute, keeping the firebase
// SDK dep contained in this module.
export async function getFirebaseAppInstanceId(): Promise<string | null> {
  try {
    return await analytics().getAppInstanceId();
  } catch (e) {
    console.warn('[analytics] getAppInstanceId failed', e);
    return null;
  }
}

export async function resetIdentity(): Promise<void> {
  try {
    // reset() mints a new anonymous id. Resetting while still anonymous strands
    // the pre-login events (Application Installed, first opens) on a person no
    // later identify() can merge, so only reset once we are actually identified.
    if (posthog.getDistinctId() !== posthog.getAnonymousId()) {
      posthog.reset();
    }
  } catch (e) {
    console.warn('[analytics] posthog.reset failed', e);
  }
  // Crashlytics detaches a user with empty string, not null.
  await Promise.all<unknown>([
    analytics().setUserId(null),
    crashlytics().setUserId(''),
  ]);
}
