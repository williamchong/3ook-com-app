import * as Notifications from 'expo-notifications';

import type { PushPermissionStatus } from './push-bridge';

export function isPushAvailable(): boolean {
  return true;
}

export async function getCurrentPermissionStatus(): Promise<PushPermissionStatus> {
  try {
    const result = await Notifications.getPermissionsAsync();
    return result.status as PushPermissionStatus;
  } catch (e) {
    console.warn('[push] getPermissionsAsync failed', e);
    return 'undetermined';
  }
}

export async function requestPushPermission(): Promise<PushPermissionStatus> {
  try {
    const existing = await Notifications.getPermissionsAsync();
    if (existing.status === 'granted') return 'granted';
    // Once a user has denied iOS permission, requestPermissionsAsync returns
    // 'denied' without re-prompting — only Settings can re-grant.
    const result = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
      },
    });
    return result.status as PushPermissionStatus;
  } catch (e) {
    console.warn('[push] requestPermissionsAsync failed', e);
    return 'denied';
  }
}

export async function getCurrentDeviceToken(): Promise<string | null> {
  try {
    // getDevicePushTokenAsync returns the raw APNs token (iOS) and FCM token
    // (Android). Intercom's sendTokenToIntercom expects these — not the
    // Expo-relayed token from getExpoPushTokenAsync.
    const token = await Notifications.getDevicePushTokenAsync();
    return typeof token.data === 'string' ? token.data : null;
  } catch (e) {
    console.warn('[push] getDevicePushTokenAsync failed', e);
    return null;
  }
}

export function addDeviceTokenListener(cb: (token: string) => void): () => void {
  const sub = Notifications.addPushTokenListener((token) => {
    if (typeof token.data === 'string') cb(token.data);
  });
  return () => sub.remove();
}

export function addNotificationResponseListener(
  cb: (data: unknown) => void,
): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    cb(response.notification.request.content.data);
  });
  return () => sub.remove();
}
