# AGENTS.md

This file provides guidance to AI coding agents (Claude Code, Cursor, Copilot, etc.) when working with code in this repository.

## Build & Development Commands

```bash
npm install                # Install dependencies
npx expo prebuild --clean  # Generate native projects (ios/ and android/)
npx expo run:ios           # Build and run on iOS simulator
npx expo run:android       # Build and run on Android emulator
npx expo start             # Start Metro dev server
npx tsc --noEmit           # Typecheck
npx expo lint              # Lint (ESLint via Expo)
```

EAS builds: `eas build --profile development|preview|production --platform ios|android`

## What This App Is

Native mobile app for [3ook.com](https://3ook.com) — a decentralized digital bookstore where books are readable, listenable, and ownable (可讀、可聽、可擁有). The platform features 1000+ books with AI-generated Cantonese/Mandarin/English narration, blockchain-based book ownership on Base, and an author-friendly revenue model.

The web app itself lives in a separate repo (`liker-land-v3`, a Nuxt 3 PWA). This repo is the **native shell** — a WebView wrapper that adds native audio playback with background audio, lock screen controls, and queue management.

## Architecture

### How it works

1. **`app/index.tsx`** — Single-screen app rendering a full-screen `WebView` at `https://3ook.com?app=1`. Wires up `postMessage` ingestion, deep-link / Universal Link / App Link handling, native back navigation, and capability advertisement (`window.__nativeBridge.features` injected via `injectedJavaScriptBeforeContentLoaded`).
2. **`services/bridge-dispatcher.ts`** — Central registry/dispatcher. Each bridge registers handlers keyed by message `type`; `dispatch(raw)` parses JSON and routes to the matching handler.
3. **`services/audio-bridge.native.ts`** — Imperative audio engine using `expo-audio`. Manages a single `AudioPlayer`, a manual track queue, cookie forwarding (Cloudflare Access auth), lock screen controls, preload/swap, and auto-advancement.
4. **`services/download-bridge.native.ts`** — Handles the `fileDownloadData` bridge message by writing a base64 payload to cache and sharing the saved file.
5. **`services/identity-bridge.native.ts`** — Fans `identifyUser` out to PostHog, Firebase Analytics, and Sentry. Firebase gets the pre-hashed `gaUserId` (SHA-256 wallet) that the web also feeds to gtag so GA4's no-PII rule holds and app + web sessions stitch.
6. **`services/intercom-bridge.native.ts`** — Intercom session updates and push-permission flows; conditionally enabled by env vars (`INTERCOM_APP_ID`, `INTERCOM_IOS_API_KEY`, `INTERCOM_ANDROID_API_KEY`).
7. **`services/push-bridge.native.ts`** — `expo-notifications` permission and token plumbing.
8. **`services/url-bridge.native.ts`** + **`services/url-storage.native.ts`** — Deep-link parsing, last-visited URL persistence, and outbound external-URL handling. Deep links are accepted only for `3ook.com` and subdomains; URL normalization always enforces `app=1`.
9. **`services/app-bound-domains.js`** + **`plugins/withAppBoundDomains.js`** — Single source of truth for iOS `WKAppBoundDomains` shared by runtime checks and the config plugin.
10. **`modules/audio-interruption`** + **`modules/battery-optimization`** — Local Expo native modules autolinked via `package.json#expo.autolinking.nativeModulesDir = "modules"`. iOS audio session interruption hooks; Android battery-optimization-exemption prompt.
11. **`services/iap-bridge.native.ts`** — RevenueCat (`react-native-purchases`) in-app purchases for the Plus subscription. `configureIAP()` runs once on start; `wrapIdentityForIAP` hooks `Purchases.logIn/logOut` into the `identifyUser`/`resetUser` identity events so the RevenueCat `appUserID` equals the backend internal user id (`likerId`, from the identity payload's `likerId` field) — the same id the RevenueCat→backend webhook resolves against. Keys come from `app.config.ts` `extra.revenueCat` (`REVENUECAT_IOS_API_KEY` / `REVENUECAT_ANDROID_API_KEY`); the `iap` capability is advertised only when a platform key is present. Entitlement truth lives on the backend (RevenueCat→backend webhook flips `isLikerPlus`), so the bridge only reports purchase results.

### Key patterns

- **Platform-split modules**: each bridge uses `.native.ts` / `.web.ts` suffixes with a shared `.d.ts` facade. Metro resolves the correct file per platform; web builds compile against no-op stubs.
- **WebView ↔ Native bridge**: Web→Native via `postMessage` JSON routed through `bridge-dispatcher`. Native→Web via `injectJavaScript` dispatching `CustomEvent('nativeAudioEvent')` or `CustomEvent('nativeBridgeEvent')`.
- **Capability advertisement**: `NATIVE_BRIDGE_FEATURES` in `app/index.tsx` is injected before content load so the web app can feature-detect what this build supports without pinning to a build number. Add a string here when introducing a new bridge web should detect.
- **Cookie forwarding**: Audio URLs require Cloudflare Access cookies. The audio bridge reads cookies via `@preeternal/react-native-cookie-manager` and passes them as request headers to `expo-audio`.
- **Plugin order matters** in `app.config.ts`, notably Intercom vs notification-related plugins.

### Message protocol

Web → Native messages are JSON with `type` and payload fields. Audio types: `load`, `pause`, `resume`, `stop`, `skipTo`, `setRate`, `seekTo`, `clearNativeCaches` (drops app-managed content caches — currently the on-disk TTS segment cache; sent by the web's clear-caches flow). IAP types: `iapPurchase` (`{ period, likerId }` — `likerId` is the backend internal user id, used as the RevenueCat `app_user_id`, NOT the evmWallet), `iapRestore` (`{ likerId }` — required for the same reason: a restore under an anonymous id can't be webhook-resolved), `iapGetOfferings`, `iapManageSubscription` (opens the native App Store/Play subscription-management UI via `Purchases.showManageSubscriptions()`; the web routes only store-owned subscribers here, Stripe subscribers go to the Stripe portal). Other bridges add their own types (e.g. identity sync, Intercom updates, push-permission requests, downloads). Native → Web events are sent as `CustomEvent` from injected JS — `nativeAudioEvent` for audio (`playbackState`, `trackChanged`, `queueEnded`) and `nativeBridgeEvent` for everything else (IAP: `iapPurchaseResult`, `iapRestoreResult`, `iapOfferings`, `iapManageResult`).

### Observability

Sentry (`@sentry/react-native`), Firebase Analytics, and PostHog (`services/posthog.ts`) are wired up. For PostHog details, refer to the code/config in this repo rather than hard-coded account metadata.

## Code Conventions

- Comments — keep concise, at most 3 lines. Avoid breaking lines mid-sentence; break at punctuation when needed.

## Commit Messages

Gitmoji style: `⬆️ Upgrade dependencies`, `✨ Add feature`, `🐛 Fix bug`, etc.
