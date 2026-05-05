import type { BridgeHandlerMap, SendToWebView } from './bridge-dispatcher';

export function isIntercomAvailable(): boolean;

export function getIntercomHandlers(send: SendToWebView): BridgeHandlerMap;

export function wrapIdentityHandlers(base: BridgeHandlerMap): BridgeHandlerMap;

export function registerIntercomEventListeners(send: SendToWebView): () => void;
