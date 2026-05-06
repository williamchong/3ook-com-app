import type { PushPermissionStatus } from './push-bridge';

export function isPushAvailable(): boolean {
  return false;
}

export async function getCurrentPermissionStatus(): Promise<PushPermissionStatus> {
  return 'undetermined';
}

export async function requestPushPermission(): Promise<PushPermissionStatus> {
  return 'undetermined';
}

export async function getCurrentDeviceToken(): Promise<string | null> {
  return null;
}

export function addDeviceTokenListener(_cb: (token: string) => void): () => void {
  return () => {};
}

export function addNotificationResponseListener(
  _cb: (data: unknown) => void,
): () => void {
  return () => {};
}
