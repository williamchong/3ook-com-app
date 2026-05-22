import type { BridgeHandlerMap } from './bridge-dispatcher';

// Web builds have no StoreKit / Play Billing — every export is a no-op so the
// shared bridge can be imported without dragging `react-native-purchases` into
// the web bundle. Mirrors identity-bridge.web.ts.
export function isIAPAvailable(): boolean {
  return false;
}

export function configureIAP(): void {}

export function getIAPHandlers(): BridgeHandlerMap {
  return {};
}

export function wrapIdentityForIAP(base: BridgeHandlerMap): BridgeHandlerMap {
  return base;
}
