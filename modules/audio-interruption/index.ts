import { Platform, requireOptionalNativeModule } from 'expo-modules-core';

interface AudioInterruptionModule {
  addListener(event: 'onInterruptionBegan', listener: () => void): { remove(): void };
  addListener(event: 'onInterruptionEnded', listener: (event: { shouldResume: boolean }) => void): { remove(): void };
}

const NativeModuleRef =
  Platform.OS === 'ios'
    ? requireOptionalNativeModule<AudioInterruptionModule>('AudioInterruption')
    : null;

export function addInterruptionBeganListener(listener: () => void) {
  return NativeModuleRef?.addListener('onInterruptionBegan', listener) ?? { remove() {} };
}

export function addInterruptionEndedListener(
  listener: (event: { shouldResume: boolean }) => void,
) {
  return NativeModuleRef?.addListener('onInterruptionEnded', listener) ?? { remove() {} };
}
