import * as Sentry from "@sentry/react-native";
import { Slot } from "expo-router";
import PostHog, { PostHogProvider } from "posthog-react-native";

Sentry.init({
  dsn: "https://316d95879bd0e47063df647af48ceb1f@o149940.ingest.us.sentry.io/4510799071608832",

  // Adds more context data to events (IP address, cookies, user, etc.)
  // For more information, visit: https://docs.sentry.io/platforms/react-native/data-management/data-collected/
  sendDefaultPii: true,

  // Enable Logs
  enableLogs: false,

  // uncomment the line below to enable Spotlight (https://spotlightjs.com)
  // spotlight: __DEV__,
});

const posthog = new PostHog(
  "phc_VOXrU28p44Z0coehNjKThwVPK5dO0A6xwQTQqThWI1c",
  {
    host: "https://us.i.posthog.com",
    captureAppLifecycleEvents: true,
  }
);

export default function RootLayout() {
  return (
    <PostHogProvider client={posthog}>
      <Slot />
    </PostHogProvider>
  );
}
