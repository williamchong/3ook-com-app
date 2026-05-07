import type { AnalyticsIdentifyTraits, AnalyticsProperties } from './analytics';

export function trackEvent(_event: string, _properties?: AnalyticsProperties): void {}

export async function identify(
  _userId: string,
  _traits: AnalyticsIdentifyTraits,
): Promise<void> {}

export async function resetIdentity(): Promise<void> {}
