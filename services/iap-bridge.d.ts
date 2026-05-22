import type { BridgeHandlerMap, SendToWebView } from './bridge-dispatcher';

export function isIAPAvailable(): boolean;
export function configureIAP(): void;
export function getIAPHandlers(send: SendToWebView): BridgeHandlerMap;
export function wrapIdentityForIAP(base: BridgeHandlerMap): BridgeHandlerMap;
