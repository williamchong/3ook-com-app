import Constants from 'expo-constants';
import { Platform } from 'react-native';
import Purchases, { PACKAGE_TYPE } from 'react-native-purchases';
import type { CustomerInfo, PurchasesPackage, PurchasesStoreProduct } from 'react-native-purchases';

import { trackEvent } from './analytics';
import type { BridgeHandlerMap, SendToWebView } from './bridge-dispatcher';
import { openExternalURL } from './url-bridge';

// Entitlement identifier configured in the RevenueCat dashboard. A web (Stripe)
// or mobile (StoreKit / Play Billing) subscriber both resolve to this single
// entitlement, so feature gating is identical across platforms. Must match the
// identifier set up in the dashboard.
const PLUS_ENTITLEMENT_ID = 'plus';

// Generic store subscription-management pages. Used as a fallback when
// RevenueCat's showManageSubscriptions() throws because it can't resolve a
// product-specific management URL — notably sandbox/test subscriptions (where
// managementURL is null), so an active subscriber can still reach the store UI.
const MANAGE_SUBSCRIPTION_URL =
  Platform.OS === 'ios'
    ? 'https://apps.apple.com/account/subscriptions'
    : 'https://play.google.com/store/account/subscriptions';

type RevenueCatConfig = { iosApiKey?: string; androidApiKey?: string };

function getApiKey(): string | undefined {
  const cfg = (Constants.expoConfig?.extra?.revenueCat ?? {}) as RevenueCatConfig;
  return Platform.OS === 'ios' ? cfg.iosApiKey : cfg.androidApiKey;
}

// Drives the `iap` capability string in app/index.tsx — only advertised when a
// platform key exists, so a misconfigured build doesn't surface a dead
// purchase button on the web side.
export function isIAPAvailable(): boolean {
  return !!getApiKey();
}

let configured = false;

// Configure once on app start (singleton). Anonymous until the identity bridge
// logs the user in via wrapIdentityForIAP; pairing logIn with `identifyUser`
// keeps the RevenueCat appUserID equal to the backend internal user id (likerId).
export function configureIAP(): void {
  if (configured) return;
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn('[iap] RevenueCat API key missing for this platform — IAP disabled.');
    return;
  }
  Purchases.configure({ apiKey, appUserID: null });
  configured = true;
}

function hasPlus(customerInfo: CustomerInfo): boolean {
  return customerInfo.entitlements.active[PLUS_ENTITLEMENT_ID] !== undefined;
}

// Maps the web's SubscriptionPlan period onto RevenueCat's predefined package
// types. Partial so an unknown period yields `undefined` (not a fake hit),
// letting the caller surface an error rather than silently charging a default.
const PERIOD_TO_PACKAGE_TYPE: Partial<Record<string, PACKAGE_TYPE>> = {
  monthly: PACKAGE_TYPE.MONTHLY,
  yearly: PACKAGE_TYPE.ANNUAL,
};

function packageForPeriod(
  packages: PurchasesPackage[],
  period: string,
): PurchasesPackage | undefined {
  const wanted = PERIOD_TO_PACKAGE_TYPE[period];
  if (!wanted) return undefined;
  // Only the exact package type for the requested period — never a fallback,
  // so we never charge a plan the user didn't pick (e.g. annual for monthly).
  return packages.find((p) => p.packageType === wanted);
}

// The web's trial model is expressed in days; store intro durations are
// period+unit (iOS `periodUnit`, Android `Period.unit`, both DAY/WEEK/MONTH/YEAR).
// Month/year are approximated so "2 weeks" → 14, "1 month" → 30 for display copy.
const DAYS_PER_UNIT: Record<string, number> = { DAY: 1, WEEK: 7, MONTH: 30, YEAR: 365 };

function periodToDays(unit: string | undefined, count: number): number {
  const per = unit ? DAYS_PER_UNIT[unit] : undefined;
  return per ? per * count : 0;
}

// Intro offer normalized for the web: the displayed trial must match what the
// store will actually grant (and the charged price the user will see), so the
// web reads these instead of hardcoding a trial it can't guarantee.
type IntroOffer = {
  trialPeriodDays: number;
  isFreeTrial: boolean;
  introPrice: number;
  introPriceString: string;
};

// Pulls the single intro offer the store attaches to the product. iOS exposes it
// as `introPrice`; Android (Play) exposes it as the default option's free / intro
// pricing phase. Returns undefined when there's no intro offer (user pays full
// price immediately) so the web shows no trial rather than a fictitious one.
function extractIntroOffer(product: PurchasesStoreProduct): IntroOffer | undefined {
  // iOS — one introductory offer per product (free trial, pay-as-you-go, or
  // pay-up-front). `cycles` is the number of intro billing periods (1 for a
  // free trial / pay-up-front), so total duration = period × cycles.
  const ios = product.introPrice;
  if (ios) {
    const cycles = ios.cycles > 0 ? ios.cycles : 1;
    return {
      trialPeriodDays: periodToDays(ios.periodUnit, ios.periodNumberOfUnits) * cycles,
      isFreeTrial: ios.price === 0,
      introPrice: ios.price,
      introPriceString: ios.priceString,
    };
  }

  // Android — the free-trial phase takes precedence over a paid intro phase
  // (a product can carry both). Price comes in micro-units.
  const phase = product.defaultOption?.freePhase ?? product.defaultOption?.introPhase;
  if (phase) {
    const cycles = phase.billingCycleCount && phase.billingCycleCount > 0 ? phase.billingCycleCount : 1;
    const price = phase.price.amountMicros / 1_000_000;
    return {
      trialPeriodDays: periodToDays(phase.billingPeriod.unit, phase.billingPeriod.value) * cycles,
      isFreeTrial: price === 0,
      introPrice: price,
      introPriceString: phase.price.formatted,
    };
  }

  return undefined;
}

// The web sends the backend internal user id as `likerId`. Normalize it
// identically everywhere (trim; empty → undefined) so identifyUser logs in under
// exactly the id purchase/restore expect — a stray space would mint a distinct
// RevenueCat appUserID the webhook can't resolve. `userId` is the evmWallet
// (analytics only) and must never be used here.
function normalizeLikerId(likerId: unknown): string | undefined {
  return typeof likerId === 'string' && likerId.trim() ? likerId.trim() : undefined;
}

// Logs the user into RevenueCat under `appUserId` (the backend internal user id
// / likerId) so purchases attribute to the right user for the webhook to match.
// Used by identifyUser (best-effort), and re-checked before purchase/restore as a
// cold-start fallback. logIn is idempotent when appUserId is unchanged. Returns
// false on failure so purchase/restore can fail closed rather than act under an
// id the backend webhook can't resolve.
async function ensureLoggedIn(appUserId?: string): Promise<boolean> {
  if (!appUserId) return false;
  try {
    await Purchases.logIn(appUserId);
    return true;
  } catch (e) {
    console.warn('[iap] ensureLoggedIn failed', e);
    return false;
  }
}

export function wrapIdentityForIAP(base: BridgeHandlerMap): BridgeHandlerMap {
  if (!isIAPAvailable()) return base;
  return {
    ...base,
    identifyUser: async (msg) => {
      // RevenueCat's appUserID must equal our backend's internal user id
      // (`likerId` = Firestore doc id), since that is what the RevenueCat→backend
      // webhook resolves against and what the Stripe path attributes purchases to.
      // The web sends it as `likerId`; `userId` is the evmWallet (analytics only)
      // and must NOT be used here.
      const appUserId = normalizeLikerId(msg.likerId);
      await Promise.all([
        base.identifyUser?.(msg),
        ensureLoggedIn(appUserId),
      ]);
    },
    resetUser: async (msg) => {
      await Promise.all([
        base.resetUser?.(msg),
        (async () => {
          try {
            await Purchases.logOut();
          } catch (e) {
            // logOut throws if the SDK is already anonymous — benign.
            console.warn('[iap] logOut failed', e);
          }
        })(),
      ]);
    },
  };
}

export function getIAPHandlers(send: SendToWebView): BridgeHandlerMap {
  if (!isIAPAvailable()) return {};

  return {
    iapPurchase: async (msg) => {
      // No default period: a malformed payload must error, not silently charge
      // the most expensive plan.
      const period = typeof msg.period === 'string' ? msg.period : '';
      // A period the store doesn't define would otherwise fall through to the
      // generic "no package" path; surface it distinctly so the web can tell a
      // malformed request apart from an offering that's genuinely missing.
      if (!(period in PERIOD_TO_PACKAGE_TYPE)) {
        send({ type: 'iapPurchaseResult', status: 'error', period, message: 'Invalid period' });
        trackEvent('iap_purchase_error', { period, reason: 'invalid_period' });
        return;
      }
      // Required: a purchase under an anonymous id can never be credited by the
      // backend webhook (which resolves entitlement by likerId), so the user
      // would pay and get nothing. Refuse instead.
      const appUserId = normalizeLikerId(msg.likerId);
      if (!appUserId) {
        send({ type: 'iapPurchaseResult', status: 'error', period, message: 'Missing user id' });
        trackEvent('iap_purchase_error', { period, reason: 'missing_liker_id' });
        return;
      }
      try {
        if (!(await ensureLoggedIn(appUserId))) {
          send({ type: 'iapPurchaseResult', status: 'error', period, message: 'Sign-in failed' });
          trackEvent('iap_purchase_error', { period, reason: 'login_failed' });
          return;
        }
        const offerings = await Purchases.getOfferings();
        const packages = offerings.current?.availablePackages ?? [];
        const pkg = packageForPeriod(packages, period);
        if (!pkg) {
          send({ type: 'iapPurchaseResult', status: 'error', period, message: 'No package available' });
          trackEvent('iap_purchase_error', { period, reason: 'no_package' });
          return;
        }
        const { customerInfo } = await Purchases.purchasePackage(pkg);
        const isPlus = hasPlus(customerInfo);
        send({
          type: 'iapPurchaseResult',
          status: 'success',
          period,
          isPlus,
          productId: pkg.product.identifier,
        });
        trackEvent('iap_purchase_success', {
          period,
          product_id: pkg.product.identifier,
          is_plus: isPlus,
        });
      } catch (e) {
        const err = e as { userCancelled?: boolean; message?: string };
        if (err.userCancelled) {
          send({ type: 'iapPurchaseResult', status: 'cancelled', period });
          trackEvent('iap_purchase_cancelled', { period });
          return;
        }
        send({ type: 'iapPurchaseResult', status: 'error', period, message: err.message || 'Purchase failed' });
        trackEvent('iap_purchase_error', { period, reason: 'exception' });
        console.warn('[iap] purchase failed', e);
      }
    },

    // App Store guideline 3.1.1 requires an account-based restore path.
    iapRestore: async (msg) => {
      // Like iapPurchase: an entitlement restored under an anonymous id can't be
      // resolved by the backend webhook (which keys on likerId), so require it and
      // log in first. The web only exposes restore to logged-in users.
      const appUserId = normalizeLikerId(msg.likerId);
      if (!appUserId) {
        send({ type: 'iapRestoreResult', status: 'error', message: 'Missing user id' });
        trackEvent('iap_restore_error', { reason: 'missing_liker_id' });
        return;
      }
      try {
        if (!(await ensureLoggedIn(appUserId))) {
          send({ type: 'iapRestoreResult', status: 'error', message: 'Sign-in failed' });
          trackEvent('iap_restore_error', { reason: 'login_failed' });
          return;
        }
        const customerInfo = await Purchases.restorePurchases();
        const isPlus = hasPlus(customerInfo);
        send({ type: 'iapRestoreResult', status: 'success', isPlus });
        trackEvent('iap_restore_success', { is_plus: isPlus });
      } catch (e) {
        const err = e as { message?: string };
        send({ type: 'iapRestoreResult', status: 'error', message: err.message || 'Restore failed' });
        trackEvent('iap_restore_error', { reason: 'exception' });
        console.warn('[iap] restore failed', e);
      }
    },

    // Opens the native store subscription-management UI (iOS App Store sheet /
    // Play subscriptions). The web routes only store-owned subscribers here;
    // Stripe subscribers go to the Stripe portal instead. Resolves once the UI
    // is presented — the SDK can't report what the user changed, so the web
    // just refreshes the session afterward.
    iapManageSubscription: async () => {
      let isFallback = false;
      try {
        await Purchases.showManageSubscriptions();
      } catch (e) {
        // RevenueCat can't always resolve a product-specific management URL
        // (sandbox subscriptions have a null managementURL, and some devices
        // can't open the store intent). Fall back to the store's generic
        // subscriptions page so an active subscriber isn't left stranded.
        try {
          await openExternalURL(MANAGE_SUBSCRIPTION_URL);
          isFallback = true;
        } catch (fallbackError) {
          const err = e as { message?: string };
          send({ type: 'iapManageResult', status: 'error', message: err.message || 'Manage failed' });
          trackEvent('iap_manage_error');
          console.warn('[iap] manage subscription failed', e, fallbackError);
          return;
        }
      }
      send({ type: 'iapManageResult', status: 'success' });
      trackEvent('iap_manage_opened', isFallback ? { is_fallback: true } : undefined);
    },

    // Lets the web display App Store / Play-accurate prices instead of the
    // Stripe-configured ones (displayed price must equal the charged price).
    // Also carries the store's intro offer (`trialPeriodDays` / `isFreeTrial` /
    // `introPrice…`) so the web shows the trial the store will actually grant
    // rather than a hardcoded one — omitted when the product has no intro offer.
    iapGetOfferings: async () => {
      try {
        const offerings = await Purchases.getOfferings();
        const packages = (offerings.current?.availablePackages ?? []).map((p) => {
          const intro = extractIntroOffer(p.product);
          return {
            period:
              p.packageType === PACKAGE_TYPE.MONTHLY
                ? 'monthly'
                : p.packageType === PACKAGE_TYPE.ANNUAL
                  ? 'yearly'
                  : p.identifier,
            productId: p.product.identifier,
            priceString: p.product.priceString,
            price: p.product.price,
            currency: p.product.currencyCode,
            ...(intro && {
              trialPeriodDays: intro.trialPeriodDays,
              isFreeTrial: intro.isFreeTrial,
              introPrice: intro.introPrice,
              introPriceString: intro.introPriceString,
            }),
          };
        });
        send({ type: 'iapOfferings', packages });
      } catch (e) {
        send({ type: 'iapOfferings', packages: [] });
        console.warn('[iap] getOfferings failed', e);
      }
    },
  };
}
