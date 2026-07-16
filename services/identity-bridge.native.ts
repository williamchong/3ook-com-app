import * as Sentry from '@sentry/react-native';

import { identify, resetIdentity } from './analytics';
import { clearAudioCache } from './audio-cache';
import type { BridgeHandlerMap } from './bridge-dispatcher';

export function getIdentityHandlers(): BridgeHandlerMap {
  return {
    identifyUser: async (msg) => {
      const userId = typeof msg.userId === 'string' ? msg.userId : undefined;
      if (!userId) return;

      const email = typeof msg.email === 'string' ? msg.email : undefined;
      const displayName =
        typeof msg.displayName === 'string' ? msg.displayName : undefined;
      const isLikerPlus = !!msg.isLikerPlus;
      const likerPlusTier =
        typeof msg.likerPlusTier === 'string' ? msg.likerPlusTier : undefined;
      const loginMethod =
        typeof msg.loginMethod === 'string' ? msg.loginMethod : undefined;
      const locale = typeof msg.locale === 'string' ? msg.locale : undefined;
      // Firebase Analytics needs the SHA-256 wallet that the web also feeds
      // to gtag, so GA4's no-PII rule is honoured and app + web sessions
      // stitch under the same User-ID. If an older web build omits it, we
      // skip setUserId rather than forward the raw wallet.
      const gaUserId =
        typeof msg.gaUserId === 'string' ? msg.gaUserId : undefined;

      await identify(userId, {
        email,
        displayName,
        isLikerPlus,
        likerPlusTier,
        loginMethod,
        locale,
        gaUserId,
      });

      Sentry.setUser({
        id: userId,
        email,
        username: displayName || userId,
      });
    },

    resetUser: async () => {
      // Drop cached TTS audio so it can't replay under a different account on a
      // shared device.
      clearAudioCache();
      await resetIdentity();
      Sentry.setUser(null);
    },
  };
}
