export type AnalyticsValue = string | number | boolean | null | undefined;
export type AnalyticsProperties = Record<string, AnalyticsValue>;

export interface AnalyticsIdentifyTraits {
  email?: string;
  displayName?: string;
  isLikerPlus?: boolean;
  likerPlusTier?: string;
  loginMethod?: string;
  locale?: string;
  // SHA-256 of the wallet — the only ID safe to forward to GA4 under its
  // no-PII rule. When absent, Firebase user ID is left unchanged.
  gaUserId?: string;
}

export function trackEvent(event: string, properties?: AnalyticsProperties): void;

export function registerSuperProperties(properties: AnalyticsProperties): void;

export function identify(
  userId: string,
  traits: AnalyticsIdentifyTraits,
): Promise<void>;

export function resetIdentity(): Promise<void>;

// Watch a boolean feature flag. `onChange` fires once with the value known at
// call time, then again on every flags reload. `undefined` means "not loaded
// yet" — callers pick their own default for it.
export function watchFeatureFlag(
  key: string,
  onChange: (enabled: boolean | undefined) => void,
): void;

export function getFirebaseAppInstanceId(): Promise<string | null>;
