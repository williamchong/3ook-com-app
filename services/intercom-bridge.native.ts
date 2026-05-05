import type { EmitterSubscription } from 'react-native';
import { AppState, DeviceEventEmitter, NativeEventEmitter, NativeModules, Platform } from 'react-native';

import type { BridgeHandlerMap, SendToWebView } from './bridge-dispatcher';
import {
  addDeviceTokenListener,
  getCurrentDeviceToken,
  getCurrentPermissionStatus,
  isPushAvailable,
  requestPushPermission as requestPushPermissionPrompt,
} from './push-bridge';

type IntercomModuleType = typeof import('@intercom/intercom-react-native');
type IntercomDefault = IntercomModuleType['default'];
type UserAttributes = import('@intercom/intercom-react-native').UserAttributes;

// `@intercom/intercom-react-native`'s JS wrapper asserts on NativeModules at
// module-eval time, so a build without the config plugin would crash on import.
// Resolve once via gated `require` and degrade to no-ops if the native module
// isn't linked.
type LoadedIntercom = { Intercom: IntercomDefault; events: IntercomModuleType['IntercomEvents'] };
const loadedIntercom: LoadedIntercom | null = (() => {
  if (!NativeModules.IntercomModule) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@intercom/intercom-react-native') as IntercomModuleType;
    return { Intercom: mod.default, events: mod.IntercomEvents };
  } catch (e) {
    console.warn('[intercom] failed to load module', e);
    return null;
  }
})();

export function isIntercomAvailable(): boolean {
  return loadedIntercom !== null;
}

// Hermes provides atob; decode the middle JWT segment (base64url) for the
// claims. Header/signature are uninteresting for IV failures, so skip them.
function decodeJwtPayload(jwt: string): unknown {
  const segment = jwt.split('.')[1];
  if (!segment) return undefined;
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    segment.length + ((4 - (segment.length % 4)) % 4),
    '='
  );
  return JSON.parse(atob(padded));
}

async function safeCall<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (__DEV__) {
      // RN's default console formatter truncates the bridge error fields;
      // destructure so Intercom's underlying NSError surfaces in Metro.
      const err = e as { code?: string; message?: string; userInfo?: unknown };
      console.warn(`[intercom] ${label} failed`, {
        code: err.code,
        message: err.message,
        userInfo: err.userInfo,
      });
    } else {
      console.warn(`[intercom] ${label} failed`, e);
    }
    return undefined;
  }
}

// All Intercom SDK ops share a single underlying user/session state. The web
// posts `identifyUser` and `intercomShow` independently, and each WebView
// message dispatches in parallel — so without a queue, `present()` can race
// `loginUserWithUserAttributes` and the messenger may open as a guest for an
// identified user (or hit "Content could not be loaded" before either login
// lands). Serialize all Intercom ops in dispatch order.
let intercomQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = intercomQueue.catch(() => undefined).then(fn);
  intercomQueue = next.catch(() => undefined);
  return next;
}

// The native SDK refuses to render the messenger ("Content could not be
// loaded") if no user session exists. Identified users are registered via
// `identifyUser`; for guests we register an unidentified session on demand.
async function ensureSession() {
  if (!loadedIntercom) return;
  const { Intercom } = loadedIntercom;
  const loggedIn = await safeCall('isUserLoggedIn', () => Intercom.isUserLoggedIn());
  if (loggedIn) return;
  await safeCall('loginUnidentifiedUser', () => Intercom.loginUnidentifiedUser());
}

// Caller must invoke this inside the serialize() queue: Identity Verification
// requires the JWT to land before the token attaches, otherwise the token
// registers against the prior (or guest) session.
async function registerPushTokenIfPossible() {
  if (!loadedIntercom) return;
  if (!isPushAvailable()) return;
  const status = await getCurrentPermissionStatus();
  if (status !== 'granted') return;
  const { Intercom } = loadedIntercom;
  const loggedIn = await safeCall('isUserLoggedIn', () => Intercom.isUserLoggedIn());
  if (!loggedIn) return;
  const token = await getCurrentDeviceToken();
  if (!token) return;
  if (token === lastRegisteredToken) return;
  // Don't route through safeCall: a swallowed failure here would still flip
  // the dedupe gate, so a transient SDK/network blip would silently disable
  // push delivery for the rest of the session.
  try {
    await Intercom.sendTokenToIntercom(token);
    lastRegisteredToken = token;
  } catch (e) {
    console.warn('[intercom] sendTokenToIntercom failed', e);
  }
}

// Dedupe successive sendTokenToIntercom calls for the same token + session.
// Cleared whenever the user identity changes (identify / logout) so a token
// shared across users doesn't get skipped after a switch.
let lastRegisteredToken: string | null = null;

export function getIntercomHandlers(send: SendToWebView): BridgeHandlerMap {
  if (!loadedIntercom) return {};
  const { Intercom } = loadedIntercom;

  return {
    intercomShow: async () => {
      await serialize(async () => {
        await ensureSession();
        // Guests can also receive admin replies via push; register the token
        // once a session exists.
        await registerPushTokenIfPossible();
        await safeCall('present', () => Intercom.present());
      });
    },

    intercomShowNewMessage: async (msg) => {
      const initial = typeof msg.message === 'string' ? msg.message : undefined;
      await serialize(async () => {
        await ensureSession();
        await registerPushTokenIfPossible();
        await safeCall('presentMessageComposer', () => Intercom.presentMessageComposer(initial));
      });
    },

    intercomLogout: async () => {
      await serialize(async () => {
        lastRegisteredToken = null;
        await safeCall('logout', () => Intercom.logout());
      });
    },

    // logEvent is buffered by Intercom pre-login, so it doesn't need to wait
    // behind a slow `loginUserWithUserAttributes` in the serial queue.
    intercomTrackEvent: async (msg) => {
      const name = typeof msg.name === 'string' ? msg.name : undefined;
      if (!name) return;
      const metaData =
        msg.metaData && typeof msg.metaData === 'object'
          ? (msg.metaData as Record<string, unknown>)
          : undefined;
      await safeCall('logEvent', () => Intercom.logEvent(name, metaData));
    },

    requestPushPermission: async () => {
      const status = await requestPushPermissionPrompt();
      if (status === 'granted') {
        await serialize(() => registerPushTokenIfPossible());
      }
      send({ type: 'pushPermissionChanged', status });
    },
  };
}

export function wrapIdentityHandlers(base: BridgeHandlerMap): BridgeHandlerMap {
  if (!loadedIntercom) return base;
  const { Intercom } = loadedIntercom;

  async function intercomIdentify(msg: Record<string, unknown>) {
    const intercomToken =
      typeof msg.intercomToken === 'string' ? msg.intercomToken : undefined;
    // Without a JWT we cannot safely identify against an Identity-Verified
    // workspace. Skip rather than create a noisy anonymous record.
    if (!intercomToken) return;

    const userId =
      typeof msg.likerId === 'string'
        ? msg.likerId
        : typeof msg.userId === 'string'
          ? msg.userId
          : undefined;
    const email = typeof msg.email === 'string' ? msg.email : undefined;
    if (!userId && !email) return;

    if (__DEV__) {
      try {
        console.log('[intercom] jwt payload', decodeJwtPayload(intercomToken));
      } catch (e) {
        console.warn('[intercom] failed to decode jwt', e);
      }
    }

    // setUserJwt must be called before loginUserWithUserAttributes for
    // JWT verification to take effect.
    await safeCall('setUserJwt', () => Intercom.setUserJwt(intercomToken));
    const attrs: UserAttributes = {
      userId,
      email,
      name: typeof msg.displayName === 'string' ? msg.displayName : undefined,
      customAttributes: {
        evm_wallet: typeof msg.evmWallet === 'string' ? msg.evmWallet : undefined,
        like_wallet: typeof msg.likeWallet === 'string' ? msg.likeWallet : undefined,
        is_liker_plus: !!msg.isLikerPlus,
        login_method: typeof msg.loginMethod === 'string' ? msg.loginMethod : undefined,
        locale: typeof msg.locale === 'string' ? msg.locale : undefined,
      },
    };
    await safeCall('loginUserWithUserAttributes', () =>
      Intercom.loginUserWithUserAttributes(attrs)
    );
  }

  return {
    ...base,
    identifyUser: async (msg) => {
      await Promise.all([
        base.identifyUser?.(msg),
        serialize(async () => {
          // The token attached to the prior guest/user session must be
          // re-sent so it migrates to the now-identified Intercom user.
          lastRegisteredToken = null;
          await intercomIdentify(msg);
          await registerPushTokenIfPossible();
        }),
      ]);
    },
    resetUser: async (msg) => {
      await Promise.all([
        base.resetUser?.(msg),
        serialize(async () => {
          lastRegisteredToken = null;
          await safeCall('logout', () => Intercom.logout());
        }),
      ]);
    },
  };
}

export function registerIntercomEventListeners(send: SendToWebView): () => void {
  if (!loadedIntercom) return () => {};
  const { events } = loadedIntercom;

  let emitter: NativeEventEmitter | typeof DeviceEventEmitter;
  if (Platform.OS === 'ios') {
    const iosEmitter = NativeModules.IntercomEventEmitter;
    if (!iosEmitter) {
      console.warn('[intercom] IntercomEventEmitter unavailable; skipping event listeners');
      return () => {};
    }
    try {
      emitter = new NativeEventEmitter(iosEmitter);
    } catch (e) {
      console.warn('[intercom] failed to construct NativeEventEmitter', e);
      return () => {};
    }
  } else {
    emitter = DeviceEventEmitter;
  }

  const subs: EmitterSubscription[] = [];

  let lastUnreadCount: number | null = null;
  subs.push(
    emitter.addListener(
      events.IntercomUnreadCountDidChange,
      (payload: { count?: number }) => {
        const count = payload?.count ?? 0;
        if (count === lastUnreadCount) return;
        lastUnreadCount = count;
        send({ type: 'intercomUnreadCountChanged', count });
      }
    )
  );
  subs.push(
    emitter.addListener(events.IntercomWindowDidShow, () => {
      send({ type: 'intercomWindowDidShow' });
    })
  );
  subs.push(
    emitter.addListener(events.IntercomWindowDidHide, () => {
      send({ type: 'intercomWindowDidHide' });
    })
  );

  // APNs/FCM rotates tokens occasionally (app restore, FCM key roll); the
  // registration helper gates on session+permission so this is safe to fire
  // eagerly.
  const unsubToken = addDeviceTokenListener(() => {
    serialize(() => registerPushTokenIfPossible());
  });

  async function syncPushPermission() {
    if (!isPushAvailable()) return;
    try {
      const status = await getCurrentPermissionStatus();
      send({ type: 'pushPermissionChanged', status });
      if (status === 'granted') {
        serialize(() => registerPushTokenIfPossible());
      }
    } catch (e) {
      console.warn('[intercom] push status check failed', e);
    }
  }
  syncPushPermission();

  // OS notification permission can change in Settings and the platform
  // doesn't notify us. Re-check on foreground so the toggle doesn't go stale.
  const appStateSub = AppState.addEventListener('change', (next) => {
    if (next === 'active') syncPushPermission();
  });

  return () => {
    unsubToken();
    appStateSub.remove();
    for (const s of subs) s.remove();
  };
}
