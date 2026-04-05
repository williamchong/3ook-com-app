import { Platform, requireOptionalNativeModule } from 'expo-modules-core';

interface BatteryOptimizationModule {
  isExempt(): boolean;
  requestExemption(): void;
}

const NativeModule =
  Platform.OS === 'android'
    ? requireOptionalNativeModule<BatteryOptimizationModule>('BatteryOptimization')
    : null;

/**
 * Shows the system dialog asking the user to exempt the app from battery
 * optimization. No-op if already exempt or not on Android.
 */
export function requestBatteryOptimizationExemption(): void {
  if (NativeModule && !NativeModule.isExempt()) {
    NativeModule.requestExemption();
  }
}
