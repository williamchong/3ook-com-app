import Constants from 'expo-constants';
import { Platform } from 'react-native';
import Purchases, { PACKAGE_TYPE } from 'react-native-purchases';
import type { CustomerInfo, PurchasesPackage } from 'react-native-purchases';

import { trackEvent } from './analytics';
import type { BridgeHandlerMap, SendToWebView } from './bridge-dispatcher';

// Entitlement identifier configured in the RevenueCat dashboard. A web (Stripe)
// or mobile (StoreKit / Play Billing) subscriber both resolve to this single
// entitlement, so feature gating is identical across platforms. Must match the
// identifier set up in the dashboard.
const PLUS_ENTITLEMENT_ID = 'plus';

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

function packageForPeriod(
  packages: PurchasesPackage[],
  period: string,
): PurchasesPackage | undefined {
  const wanted = period === 'monthly' ? PACKAGE_TYPE.MONTHLY : PACKAGE_TYPE.ANNUAL;
  // Fall back to the first package so a non-standard offering still purchases.
  return packages.find((p) => p.packageType === wanted) ?? packages[0];
}

// Logs the user into RevenueCat under `appUserId` (the backend internal user id
// / likerId) so purchases attribute to the right user for the webhook to match.
// Used by identifyUser, and re-checked before a purchase as a cold-start
// fallback. logIn is idempotent when appUserId is unchanged.
async function ensureLoggedIn(appUserId?: string): Promise<void> {
  if (!appUserId) return;
  try {
    await Purchases.logIn(appUserId);
  } catch (e) {
    console.warn('[iap] ensureLoggedIn failed', e);
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
      const appUserId = typeof msg.likerId === 'string' ? msg.likerId : undefined;
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
      const period = typeof msg.period === 'string' ? msg.period : 'yearly';
      const appUserId = typeof msg.appUserId === 'string' ? msg.appUserId : undefined;
      await ensureLoggedIn(appUserId);
      try {
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
        send({ type: 'iapPurchaseResult', status: 'error', period, message: err.message });
        trackEvent('iap_purchase_error', { period, reason: 'exception' });
        console.warn('[iap] purchase failed', e);
      }
    },

    // App Store guideline 3.1.1 requires an account-based restore path.
    iapRestore: async () => {
      try {
        const customerInfo = await Purchases.restorePurchases();
        const isPlus = hasPlus(customerInfo);
        send({ type: 'iapRestoreResult', status: 'success', isPlus });
        trackEvent('iap_restore_success', { is_plus: isPlus });
      } catch (e) {
        const err = e as { message?: string };
        send({ type: 'iapRestoreResult', status: 'error', message: err.message });
        trackEvent('iap_restore_error');
        console.warn('[iap] restore failed', e);
      }
    },

    // Lets the web display App Store / Play-accurate prices instead of the
    // Stripe-configured ones (displayed price must equal the charged price).
    iapGetOfferings: async () => {
      try {
        const offerings = await Purchases.getOfferings();
        const packages = (offerings.current?.availablePackages ?? []).map((p) => ({
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
        }));
        send({ type: 'iapOfferings', packages });
      } catch (e) {
        send({ type: 'iapOfferings', packages: [] });
        console.warn('[iap] getOfferings failed', e);
      }
    },
  };
}
