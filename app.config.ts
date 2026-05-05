import type { ExpoConfig } from 'expo/config';

const INTERCOM_REGIONS = ['US', 'EU', 'AU'] as const;
type IntercomRegion = (typeof INTERCOM_REGIONS)[number];

function resolveIntercomRegion(): IntercomRegion {
  const raw = process.env.INTERCOM_REGION;
  if (!raw) return 'US';
  if ((INTERCOM_REGIONS as readonly string[]).includes(raw)) {
    return raw as IntercomRegion;
  }
  console.warn(
    `[intercom] invalid INTERCOM_REGION "${raw}" — expected one of ${INTERCOM_REGIONS.join(', ')}; defaulting to US.`
  );
  return 'US';
}

const intercomEnv = {
  appId: process.env.INTERCOM_APP_ID,
  iosApiKey: process.env.INTERCOM_IOS_API_KEY,
  androidApiKey: process.env.INTERCOM_ANDROID_API_KEY,
  region: resolveIntercomRegion(),
};

const intercomPlugin: NonNullable<ExpoConfig['plugins']>[number] | null =
  intercomEnv.appId && intercomEnv.iosApiKey && intercomEnv.androidApiKey
    ? [
        '@intercom/intercom-react-native',
        {
          appId: intercomEnv.appId,
          iosApiKey: intercomEnv.iosApiKey,
          androidApiKey: intercomEnv.androidApiKey,
          intercomRegion: intercomEnv.region,
        },
      ]
    : null;

if (!intercomPlugin) {
  console.warn(
    '[intercom] INTERCOM_APP_ID / INTERCOM_IOS_API_KEY / INTERCOM_ANDROID_API_KEY missing — Intercom plugin disabled in this build.'
  );
}

const config: ExpoConfig = {
  name: '3ook.com',
  owner: 'likerland',
  slug: '3ook-com-app',
  version: '1.1.6',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme: 'com.3ook',
  userInterfaceStyle: 'automatic',
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'land.liker.book3app',
    googleServicesFile: './GoogleService-Info.plist',
    associatedDomains: ['applinks:3ook.com', 'webcredentials:3ook.com'],
    infoPlist: {
      CFBundleDisplayName: '3ook Reader',
      ITSAppUsesNonExemptEncryption: false,
      NSMicrophoneUsageDescription:
        'This app uses your microphone to record your voice and create a custom voice for the text-to-speech feature.',
      NSCameraUsageDescription:
        'This app uses the camera to take a profile photo and capture photos for customer service requests.',
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
        NSAllowsArbitraryLoadsForMedia: true,
      },
      UIBackgroundModes: ['remote-notification'],
    },
  },
  android: {
    googleServicesFile: './google-services.json',
    package: 'land.liker.book3app',
    permissions: [
      'android.permission.WAKE_LOCK',
      'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
    ],
    adaptiveIcon: {
      backgroundColor: '#131313',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        data: [
          {
            scheme: 'https',
            host: '3ook.com',
          },
        ],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
  },
  web: {
    output: 'static',
    favicon: './assets/images/favicon.png',
  },
  plugins: [
    'expo-router',
    [
      'expo-splash-screen',
      {
        image: './assets/images/splash-icon.png',
        imageWidth: 200,
        resizeMode: 'contain',
        backgroundColor: '#131313',
        dark: {
          backgroundColor: '#131313',
        },
      },
    ],
    [
      '@sentry/react-native/expo',
      {
        url: 'https://sentry.io/',
        project: '3ook-com-app',
        organization: 'likerland-team',
      },
    ],
    [
      'expo-audio',
      {
        enableBackgroundPlayback: true,
      },
    ],
    'expo-font',
    'expo-image',
    'expo-web-browser',
    'expo-asset',
    'expo-localization',
    [
      'expo-build-properties',
      {
        ios: {
          useFrameworks: 'static',
          forceStaticLinking: ['RNFBApp', 'RNFBAnalytics'],
          ccacheEnabled: true,
        },
        android: {
          buildArchs: ['arm64-v8a'],
        },
      },
    ],
    '@react-native-firebase/app',
    'expo-sharing',
    './plugins/withAppBoundDomains',
    // Intercom must precede any plugin that registers its own
    // FirebaseMessagingService (e.g. expo-notifications). Intercom's
    // auto-generated service routes Intercom pushes to the SDK and forwards
    // everything else; flipping the order shadows Intercom's handler.
    ...(intercomPlugin ? [intercomPlugin] : []),
    'expo-notifications',
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    router: {},
    eas: {
      projectId: 'b9b3551b-65fa-4f8e-b570-2bbb220b971b',
    },
  },
};

export default config;
