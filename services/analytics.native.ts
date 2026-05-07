import analytics from '@react-native-firebase/analytics';

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

export async function identify(
  userId: string,
  traits: AnalyticsIdentifyTraits,
): Promise<void> {
  const { email, displayName, isLikerPlus, loginMethod, locale, gaUserId } = traits;

  try {
    posthog.identify(userId, {
      email: email ?? null,
      name: displayName ?? null,
      is_liker_plus: !!isLikerPlus,
      login_method: loginMethod ?? null,
      locale: locale ?? null,
    });
  } catch (e) {
    console.warn('[analytics] posthog.identify failed', e);
  }

  const fa = analytics();
  const tasks: Promise<void>[] = [
    fa.setUserProperties({
      is_liker_plus: String(!!isLikerPlus),
      login_method: loginMethod ?? '',
      locale: locale ?? '',
    }),
  ];
  if (gaUserId) tasks.push(fa.setUserId(gaUserId));
  await Promise.all(tasks);
}

export async function resetIdentity(): Promise<void> {
  try {
    posthog.reset();
  } catch (e) {
    console.warn('[analytics] posthog.reset failed', e);
  }
  await analytics().setUserId(null);
}
