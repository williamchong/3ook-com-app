import * as Sentry from '@sentry/react-native';
import analytics from '@react-native-firebase/analytics';
import type PostHog from 'posthog-react-native';
import type { BridgeHandlerMap } from './bridge-dispatcher';

export function getIdentityHandlers(posthog: PostHog): BridgeHandlerMap {
  return {
    identifyUser: async (msg) => {
      const userId = typeof msg.userId === 'string' ? msg.userId : undefined;
      if (!userId) return;

      const email = typeof msg.email === 'string' ? msg.email : undefined;
      const displayName =
        typeof msg.displayName === 'string' ? msg.displayName : undefined;
      const isLikerPlus = !!msg.isLikerPlus;
      const loginMethod =
        typeof msg.loginMethod === 'string' ? msg.loginMethod : undefined;

      posthog.identify(userId, {
        email: email ?? null,
        name: displayName ?? null,
        is_liker_plus: isLikerPlus,
        login_method: loginMethod ?? null,
      });

      const fa = analytics();
      await Promise.all([
        fa.setUserId(userId),
        fa.setUserProperties({
          is_liker_plus: String(isLikerPlus),
          login_method: loginMethod ?? '',
        }),
      ]);

      Sentry.setUser({
        id: userId,
        email,
        username: displayName || userId,
      });
    },

    resetUser: async () => {
      posthog.reset();
      await analytics().setUserId(null);
      Sentry.setUser(null);
    },
  };
}
