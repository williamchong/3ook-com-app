export type AnalyticsValue = string | number | boolean | null | undefined;
export type AnalyticsProperties = Record<string, AnalyticsValue>;

export interface AnalyticsIdentifyTraits {
  email?: string;
  displayName?: string;
  isLikerPlus?: boolean;
  loginMethod?: string;
  locale?: string;
  // SHA-256 of the wallet — the only ID safe to forward to GA4 under its
  // no-PII rule. When absent, Firebase user ID is left unchanged.
  gaUserId?: string;
}

export function trackEvent(event: string, properties?: AnalyticsProperties): void;

export function identify(
  userId: string,
  traits: AnalyticsIdentifyTraits,
): Promise<void>;

export function resetIdentity(): Promise<void>;
