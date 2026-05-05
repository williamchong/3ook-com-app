import type { BridgeHandlerMap, SendToWebView } from './bridge-dispatcher';

export function isIntercomAvailable(): boolean {
  return false;
}

export function getIntercomHandlers(_send: SendToWebView): BridgeHandlerMap {
  return {};
}

export function wrapIdentityHandlers(base: BridgeHandlerMap): BridgeHandlerMap {
  return base;
}

export function registerIntercomEventListeners(_send: SendToWebView): () => void {
  return () => {};
}
