export type PushPermissionStatus = 'granted' | 'denied' | 'undetermined';

export function isPushAvailable(): boolean;
export function getCurrentPermissionStatus(): Promise<PushPermissionStatus>;
export function requestPushPermission(): Promise<PushPermissionStatus>;
export function getCurrentDeviceToken(): Promise<string | null>;
export function addDeviceTokenListener(cb: (token: string) => void): () => void;
export function addNotificationResponseListener(
  cb: (data: unknown) => void,
): () => void;
