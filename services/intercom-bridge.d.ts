import type { BridgeHandlerMap, SendToWebView } from './bridge-dispatcher';

export function isIntercomAvailable(): boolean;

export function isIntercomPushSupported(): boolean;

export function getIntercomHandlers(send: SendToWebView): BridgeHandlerMap;

export function wrapIdentityHandlers(
  base: BridgeHandlerMap,
  send: SendToWebView,
): BridgeHandlerMap;

export function registerIntercomEventListeners(send: SendToWebView): () => void;

export function resyncPushStatusToWeb(send: SendToWebView): Promise<void>;
