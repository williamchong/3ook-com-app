import * as Sentry from "@sentry/react-native";
import { Slot } from "expo-router";

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

export default function RootLayout() {
  return <Slot />;
}
