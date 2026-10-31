# ADR 0002 — The patient app: Expo, SSE, Expo push, and a shared i18n package

- **Status:** Accepted
- **Date:** 2026-10-30
- **Phase:** UPGRADE-PLAN 2.1–2.3

## Context

Phase 2 adds a React Native patient app (`apps/mobile`) next to the web token
page. It does the same job as `/t/[publicId]`: scan the poster, take a number,
watch the position, get told when to come back. Four decisions had trade-offs.

## Decisions

### 1. Expo (managed, Expo Router) rather than bare React Native

- + EAS Build produces an APK without a local Android SDK, which is what the
  owner needs on Windows.
- + Camera, SecureStore, notifications and localisation are first-party modules
  that track the SDK.
- − Push does not work in Expo Go on Android (since SDK 53), so testing push
  needs a development build (`eas build --profile development`).

### 2. Live updates over the existing SSE stream, not Socket.io

ADR 0001 said the mobile app should stay on SSE unless it needs to send. It
doesn't: the patient only listens. The app uses `react-native-sse`, with the
library's own fixed-interval retry switched off so that `domain/live-token.ts`
owns reconnection (capped, jittered exponential backoff). There is also a
30-second REST refresh, plus a reconnect when the app returns to the
foreground, because phones suspend background sockets and a silently dead
stream is the failure the TV display was built to avoid.

### 3. Expo push as a new channel in the existing chain, not raw FCM

- The API sends to `https://exp.host/--/api/v2/push/send`. Expo forwards to FCM
  or APNs, so the API holds no Firebase service-account key. The EAS project
  holds the FCM credentials instead.
- It is one more `NotificationChannel` (`expo`), first in the chain:
  `expo → push → sms → none`. Installing the app is the strongest signal of how
  the patient wants to be reached, and a native notification survives Android
  battery savers that silence a browser. Both free channels come before SMS.
  The chain still stops at the first channel that delivers, so a patient with
  the app *and* a Web Push subscription is buzzed once.
- Device tokens live in their own table (`expo_push_tokens`), bound to the
  token like `push_subscriptions`. They cascade-delete with the token and are
  removed when it finishes or when Expo answers `DeviceNotRegistered`. An Expo
  token is a string, not a URL, so registration cannot be used for SSRF the way
  an unchecked Web Push endpoint could.
- Push *receipts* (the second, delayed Expo check) are not polled yet. The
  ticket's immediate `DeviceNotRegistered` covers the common uninstall case.

### 4. Shared strings in `packages/i18n`, without an npm workspace

The repo is deliberately not a workspace (Prisma's engines). So the package has
no build step and no dependencies, and each app compiles its TypeScript source
directly:

- web: a `tsconfig` path plus Next's `experimental.externalDir`. The web Docker
  image is now built from the repository root so it can see `packages/`.
- mobile: a `tsconfig` path plus Metro `watchFolders` and `extraNodeModules`.
- Jest in both apps maps `@queuelk/i18n` to the source. The package's own tests
  run in the web app's Jest.

The cost is one alias per tool instead of one `dependencies` entry. The benefit
is one catalogue: the app's `app.*` keys sit next to the web keys, and the
`Record<TranslationKey, string>` typing makes a missing Sinhala or Tamil
string a compile error in both apps.

## Consequences

- The app's domain logic (QR parsing, position wording, ETA, SecureStore
  restore, reconnection, push registration, what a scan opens) is plain
  TypeScript under `src/domain/`, tested without a phone. Screens are thin.
- The EAS project id and FCM credentials belong to the owner's Expo account and
  are not in the repo. Until `eas init` runs, the app works fully but "Notify me"
  reports notifications as unavailable.
