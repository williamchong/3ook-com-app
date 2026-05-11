import type { EmitterSubscription } from 'react-native';
import { AppState, DeviceEventEmitter, NativeEventEmitter, NativeModules, Platform } from 'react-native';

import { trackEvent } from './analytics';
import type { BridgeHandlerMap, SendToWebView } from './bridge-dispatcher';
import {
  addDeviceTokenListener,
  addNotificationResponseListener,
  getCurrentDeviceToken,
  getCurrentPermissionStatus,
  hasPromptedBefore,
  isPushAvailable,
  requestPushPermission as requestPushPermissionPrompt,
} from './push-bridge';
import type { PushPermissionStatus } from './push-bridge';

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

export function isIntercomPushSupported(): boolean {
  return isIntercomAvailable() && isPushAvailable();
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

function getJwtExp(jwt: string): number | undefined {
  try {
    const payload = decodeJwtPayload(jwt) as { exp?: unknown } | undefined;
    return typeof payload?.exp === 'number' ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

const JWT_EXP_SKEW_S = 30;

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
  const status = await readPushStatus();
  if (status !== 'granted') return;
  const { Intercom } = loadedIntercom;
  const loggedIn = await safeCall('isUserLoggedIn', () => Intercom.isUserLoggedIn());
  if (!loggedIn) return;
  const token = await getCurrentDeviceToken();
  if (!token) return;
  if (token === lastRegisteredToken) return;
  const tokenChanged = lastRegisteredToken !== null;
  // Don't route through safeCall: a swallowed failure here would still flip
  // the dedupe gate, so a transient SDK/network blip would silently disable
  // push delivery for the rest of the session.
  try {
    await Intercom.sendTokenToIntercom(token);
    lastRegisteredToken = token;
    trackEvent('push_token_registered', { token_changed: tokenChanged });
  } catch (e) {
    console.warn('[intercom] sendTokenToIntercom failed', e);
    trackEvent('push_token_registration_failed');
  }
}

// Dedupe successive sendTokenToIntercom calls for the same token + session.
// Cleared whenever the user identity changes (identify / logout) so a token
// shared across users doesn't get skipped after a switch.
let lastRegisteredToken: string | null = null;

// `identifyUser` fires on every cold start and session refresh, not just
// fresh login. iOS's permission status is sticky once it leaves
// 'undetermined' (only Settings can flip it, handled via foreground sync),
// so cache the resolved value to skip the native bridge call on the chatty
// path. Refreshed by syncPushStatus() on app foreground.
let cachedPushStatus: PushPermissionStatus | null = null;
async function readPushStatus(): Promise<PushPermissionStatus> {
  if (cachedPushStatus !== null && cachedPushStatus !== 'undetermined') {
    return cachedPushStatus;
  }
  cachedPushStatus = await getCurrentPermissionStatus();
  return cachedPushStatus;
}

// Three call sites emit pushPermissionChanged with the same payload (foreground
// sync, identify-time prompt, web-driven request). Skip dispatches when the
// value hasn't moved so web doesn't react redundantly.
let lastDispatchedPushStatus: PushPermissionStatus | null = null;
function dispatchPushStatus(send: SendToWebView, status: PushPermissionStatus): void {
  if (status === lastDispatchedPushStatus) return;
  lastDispatchedPushStatus = status;
  send({ type: 'pushPermissionChanged', status });
}

// Inner dedupe (lastRegisteredToken) makes eager calls cheap.
function queueTokenRegistration(): void {
  serialize(() => registerPushTokenIfPossible());
}

function applyPushStatus(send: SendToWebView, status: PushPermissionStatus): void {
  const previous = cachedPushStatus;
  cachedPushStatus = status;
  if (previous !== status) {
    trackEvent('push_permission_changed', {
      status,
      previous_status: previous ?? 'unknown',
    });
  }
  dispatchPushStatus(send, status);
  if (status === 'granted') queueTokenRegistration();
}

async function syncPushStatus(send: SendToWebView): Promise<void> {
  if (!isPushAvailable()) return;
  try {
    applyPushStatus(send, await getCurrentPermissionStatus());
  } catch (e) {
    console.warn('[intercom] push status check failed', e);
  }
}

// WebView reloads (e.g. after iOS kills the content process) land in a fresh
// JS context with no memory of prior dispatches; reset the dedupe so the
// next emit lands instead of being suppressed.
export function resyncPushStatusToWeb(send: SendToWebView): Promise<void> {
  lastDispatchedPushStatus = null;
  return syncPushStatus(send);
}

// Intercom RN's native `isIntercomPushNotification:` helper isn't bridged to
// JS, so detect Intercom pushes by looking for known payload keys. False
// positives here are bounded — the worst case is opening the messenger for a
// foreign push, which the user can dismiss.
function looksLikeIntercomPush(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return 'conversation_id' in d || 'intercom_push_type' in d || 'instance_id' in d;
}

// Tapping a push notification launches the app via getInitialURL and the
// expo-notifications response listener consumes the tap event before Intercom
// ever sees it, so the messenger never auto-opens. Detect Intercom pushes
// ourselves and present the messenger through the serialize queue so the
// present call orders correctly against any in-flight identifyUser.
function handleIntercomNotificationTap(data: unknown): void {
  const isIntercom = looksLikeIntercomPush(data);
  const intercomPushType =
    isIntercom && data && typeof data === 'object'
      ? (data as Record<string, unknown>).intercom_push_type
      : undefined;
  trackEvent('push_notification_tapped', {
    is_intercom_push: isIntercom,
    intercom_push_type: typeof intercomPushType === 'string' ? intercomPushType : null,
  });
  if (!loadedIntercom) return;
  if (!isIntercom) return;
  const { Intercom } = loadedIntercom;
  serialize(async () => {
    await ensureSession();
    await safeCall('present', () => Intercom.present());
  });
}

export function getIntercomHandlers(send: SendToWebView): BridgeHandlerMap {
  if (!loadedIntercom) return {};
  const { Intercom } = loadedIntercom;

  return {
    intercomShow: async () => {
      trackEvent('intercom_show_requested');
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
      trackEvent('intercom_new_message_started', { has_initial_text: !!initial });
      await serialize(async () => {
        await ensureSession();
        await registerPushTokenIfPossible();
        await safeCall('presentMessageComposer', () => Intercom.presentMessageComposer(initial));
      });
    },

    intercomLogout: async () => {
      trackEvent('intercom_logout');
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
      trackEvent('intercom_event_logged', { name, has_metadata: !!metaData });
      await safeCall('logEvent', () => Intercom.logEvent(name, metaData));
    },

    requestPushPermission: async () => {
      await runPushPrompt(send);
    },
  };
}

// Safe to call outside the Intercom serialize queue — applyPushStatus's
// queueTokenRegistration re-enters the queue itself.
async function runPushPrompt(send: SendToWebView): Promise<void> {
  trackEvent('push_permission_prompted', {
    previous_status: cachedPushStatus ?? 'unknown',
  });
  applyPushStatus(send, await requestPushPermissionPrompt());
}

// 'undetermined' is iOS-only in practice; on Android the never-asked state
// surfaces as 'denied' (see push-bridge.native.ts). Fall back to the persisted
// marker so first-launch users on Android still get prompted.
async function maybePromptForPushPermission(send: SendToWebView): Promise<void> {
  if (!isPushAvailable()) return;
  const status = await readPushStatus();
  if (status === 'granted') return;
  if (status === 'undetermined') {
    await runPushPrompt(send);
    return;
  }
  if (Platform.OS !== 'android') return;
  if (await hasPromptedBefore()) return;
  await runPushPrompt(send);
}

export function wrapIdentityHandlers(
  base: BridgeHandlerMap,
  send: SendToWebView,
): BridgeHandlerMap {
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
        // Log only IDs/timestamps — email and custom attributes can land in
        // crash-reporter breadcrumbs from dev builds.
        const payload = decodeJwtPayload(intercomToken) as
          | Record<string, unknown>
          | undefined;
        if (payload) {
          console.log('[intercom] jwt claims', {
            user_id: payload.user_id,
            exp: payload.exp,
            iat: payload.iat,
          });
        }
      } catch (e) {
        console.warn('[intercom] failed to decode jwt', e);
      }
    }

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

    // loginUserWithUserAttributes re-verifies the JWT and tears down the
    // session on any verification miss, so skip it when the SDK already has
    // the same user logged in (covers cold starts where the SDK restored its
    // session from keychain but our module state is fresh).
    const incomingKey = userId ?? email;
    const current = await safeCall('fetchLoggedInUserAttributes', () =>
      Intercom.fetchLoggedInUserAttributes()
    );
    const currentKey = current?.userId ?? current?.email;
    const sameUser =
      incomingKey !== undefined &&
      currentKey !== undefined &&
      currentKey !== '' &&
      incomingKey === currentKey;

    if (sameUser) {
      // updateUser doesn't re-trigger JWT verification, so a stale cached
      // JWT can't blow up the session here.
      await safeCall('updateUser', () => Intercom.updateUser(attrs));
      return;
    }

    // An expired, undecodable, or malformed token will fail server-side IV
    // check and leave us with no session at all — worse than keeping the
    // prior one. Skip and let web retry with a fresh JWT.
    const incomingExp = getJwtExp(intercomToken);
    const now = Math.floor(Date.now() / 1000);
    if (
      incomingExp === undefined ||
      !Number.isFinite(incomingExp) ||
      incomingExp - JWT_EXP_SKEW_S <= now
    ) {
      console.warn('[intercom] skipping login: JWT unusable', {
        exp: incomingExp,
        now,
      });
      return;
    }

    // Push token must re-register so it migrates to the now-identified user.
    lastRegisteredToken = null;
    // setUserJwt must precede loginUserWithUserAttributes for IV to apply.
    await safeCall('setUserJwt', () => Intercom.setUserJwt(intercomToken));
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
          await intercomIdentify(msg);
          await registerPushTokenIfPossible();
        }),
        // Outside serialize so the modal prompt doesn't stall queued Intercom
        // ops; post-grant registration re-enters the queue itself.
        maybePromptForPushPermission(send),
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
      trackEvent('intercom_messenger_opened', {
        unread_count_at_open: lastUnreadCount ?? 0,
      });
      send({ type: 'intercomWindowDidShow' });
    })
  );
  subs.push(
    emitter.addListener(events.IntercomWindowDidHide, () => {
      trackEvent('intercom_messenger_closed');
      send({ type: 'intercomWindowDidHide' });
    })
  );

  // APNs/FCM rotates tokens occasionally (app restore, FCM key roll); the
  // registration helper gates on session+permission so this is safe to fire
  // eagerly.
  const unsubToken = addDeviceTokenListener(() => {
    queueTokenRegistration();
  });

  // expo-notifications buffers the most recent response until a JS listener
  // attaches, so registering here (from useEffect on mount) is early enough to
  // catch cold-launch taps as well as warm-app taps.
  const unsubResponse = addNotificationResponseListener(handleIntercomNotificationTap);

  // First sync is now driven by WebView onLoadEnd via resyncPushStatusToWeb,
  // which guarantees the web JS context exists to receive the dispatch.
  // Foreground transitions still need their own re-check because Settings
  // can flip permission while the app is backgrounded.
  const appStateSub = AppState.addEventListener('change', (next) => {
    if (next === 'active') syncPushStatus(send);
  });

  return () => {
    unsubToken();
    unsubResponse();
    appStateSub.remove();
    for (const s of subs) s.remove();
  };
}
