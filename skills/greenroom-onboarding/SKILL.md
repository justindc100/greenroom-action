---
name: greenroom-onboarding
description: Set up Greenroom (the virtual-user QA check for web and iOS pull requests) in the repository you are working in. Use when asked to "set up Greenroom", "add Greenroom to this repo", "onboard this app to Greenroom", or to draft .github/workflows/greenroom.yml, .greenroom/environment.json and .greenroom/state-contract.json, including for an app that starts behind a sign-in wall. Ends with a reviewable diff and an owner checklist; never commits, pushes, or handles a secret value.
---

# Greenroom onboarding

You are the customer's coding agent, working inside the customer's repository. Greenroom has no write access to it and never will. Your output is a reviewable diff of three files plus a short list of steps only the repository owner can do. You do not commit, push, open pull requests, store secrets, or paste a secret value anywhere.

The helper `scripts/greenroom-onboard.mjs` (next to this file) does the mechanical parts: it reads the tree, drafts the three files, checks them, and prints the owner checklist. It needs Node 18 or newer, no dependencies, and no network beyond one read of the public docs for the current workflow pin. Run it with `node <path-to-this-skill>/scripts/greenroom-onboard.mjs`.

Quote every path and pattern you pass to a shell: route directories such as `app/(tabs)/today.tsx` contain parentheses, and zsh treats an unquoted `(tabs)` as a glob and `$B:path` as a history modifier. Every example below is written with the quoting it needs.

Read `references/` when you need the exact schema of a file:

- `references/ci-workflow.md`: the reusable-workflow job, its inputs, the pin rule, the lockfile recipe, the bundle-id choice.
- `references/environment-manifest.md`: every manifest field, the rules that reject a manifest, public SDK keys, third-party hosts.
- `references/state-contract.md`: states, sources, sharedSources, routerKind, redirect routes, system alerts, and how a diff scopes to screens.
- `references/authenticated-apps.md`: the session-import contract for a signed-in app, rotating refresh tokens, startup alerts, and the import paths you must remove.

## Procedure

### 1. Detect what you are onboarding

```
node "<skill>/scripts/greenroom-onboard.mjs" detect .
```

Read the report and decide four things. Check each against the source before trusting the report; it is a heuristic.

- **Framework and platform.** Expo / React Native / SwiftUI (or any Xcode project) are `ios` and run on a macOS runner against a simulator build. Vite / Next / a custom static site are `web` and run against a preview served inside the job. A repository with both a mobile app and a web app is two onboardings; do the one the user asked for and say so. A monorepo with the app in a subdirectory: pass `--root <dir>` to every command.
- **Sign-in wall.** The report says "sign-in wall detected" when it finds a sign-in route or a provider SDK. Confirm by reading the layout or root component that redirects unauthenticated users. Three cases:
  - No wall (or an anonymous account the app creates silently on first launch): `signed_out`. The walk starts on whatever a fresh install shows.
  - A wall, iOS, and the app keeps its session in `expo-secure-store`, `react-native-keychain` or a native Keychain item: `session_import` (section 4).
  - A wall on web, or a session the runner cannot import (items stored with `requireAuthentication: true`, a session that only lives in memory): onboard the signed-out surfaces only, mark the rest as out of scope, and tell the user why. Do not invent a bypass.
- **Router.** `expo-router` (an `app/` directory), `react-navigation` (one file that declares `<Stack.Screen name=...>`), `swiftui` (the target's source root), or `hash-spa` (one file that defines a `views` object). Anything else has no deterministic extractor; the contract still works through `sources` globs. The report marks routes that only redirect (`app/index.tsx` with a bare `<Redirect>`): they are not screens and the draft leaves them out of `states` and puts their file in `sharedSources`.
- **Build.** For iOS: the workspace or project, the scheme, the app name, whether `ios/` is generated (`expo prebuild`) or tracked, the CocoaPods lockfile and its version, whether Sentry is present. For web: the build command and its output directory.

**An existing setup.** If the tree has `.github/workflows/greenroom.yml` or `.greenroom/`, read them first: you are updating a setup, and the diff must preserve every deliberate value (goals, notes, hosts) that is still right. The helper reads only the working tree. If the user says an earlier Greenroom setup exists but the report says "Existing setup: none", it lives on another branch: ask which branch, then read those files from it without switching (`git show <branch>:.greenroom/environment.json`, `git show "<branch>:.github/workflows/greenroom.yml"`, `git ls-tree -r --name-only <branch> -- scripts .greenroom`), and reuse what is still right (a `Podfile.lock`, hosts, goals). Import paths on that branch are only removed if that branch is merged into the base branch; say which branch the diff is against, and never rebase or merge yourself.

### 2. Gather the hosts the app actually contacts

`allowedHosts` must list every host the test build reaches: the backend, media and asset CDNs, fonts, analytics, crash reporting, feature flags, purchases. A request to an unlisted host ends the walk with the host named; that is correct behavior, and the fix is completing the list, never widening policy. `productionHosts` lists the production hosts so a walk can prove it never reached one; a host may not be in both.

The report gives you three sources; use all of them and then grep yourself:

- Literal URLs in source (`api-or-service`, `asset-cdn`, `font-cdn`). Ignore `probably-a-link` hosts (App Store, docs, legal citations) that open in a browser rather than being fetched.
- SDK hosts implied by dependencies (RevenueCat, PostHog, Sentry, Meta, Firebase, sign-in providers). A native SDK contacts its host whether or not any JavaScript does. Sentry: the ingest host is only knowable from the DSN, which is a public value the app ships with. A test build compiled without a DSN sends nothing, so list no Sentry host at all; only when the test build carries a DSN, list its exact host. Never read a `.env` to find it.
- Build-time configuration (`process.env.*_URL`, `eas.json` profiles, `.env.example`). The host the test build is compiled with is the one to list. Never read a real `.env`; the helper does not either.

Then run this (adjust the directories to the tree) for anything the report missed, and check `<link>`/`<script>` tags in HTML for web:

```
grep -rn -E 'fetch\(|axios|WebSocket|XMLHttpRequest|NSURLSession|URLSession' src app Sources
```

Decision: **which isolated backend does the test build talk to?** Look for a staging or test environment in `eas.json`, `.env.example`, `app.config.*`, or the build profiles. If none exists, ask the user for the host of the isolated test backend; do not guess a hostname and do not use production. Pass it as `--backend-host` so the checklist names it. For a web app served from the job, the backend is usually `127.0.0.1` plus whatever the preview calls.

Decision: **does the app need a public SDK key to start?** The report lists the key variables the build reads (`sdk-keys`). An SDK the test build leaves unconfigured usually makes no requests; but some SDK initializers throw without a key (RevenueCat's `configure` is one), and then the startup chain never runs and the app shows a blank screen. Read the initializer: if it throws or blocks startup without the key, pass `--sdk-keys <NAME>` so `prepare` exports a placeholder for a **test project's public key**, and add the SDK's host to `allowedHosts`. Public SDK keys (RevenueCat public keys, PostHog project tokens, Stripe publishable keys) ship inside the app binary and may be exported in `prepare` through a GitHub Actions variable; a private key, secret, service-role key or signing key never goes in `prepare`, and `prepare` cannot read repository secrets anyway. If the SDK does not need a key to start, leave the variable unset so the SDK stays off in the test build and its host goes to `productionHosts`.

### 3. Draft the three files

Get the current stable pin from the public docs (the helper does this unless you pass `--pin`):

```
node "<skill>/scripts/greenroom-onboard.mjs" pin --platform ios   # or web
```

It prints the `uses:` line the quickstart currently quotes, and which runner release that is when it can tell (inside the Greenroom repository it reads the trust list; from a customer repository the docs page quotes the SHA only). The SHA is the identity Greenroom trusts; record the SHA, not a version number. Never copy a SHA from memory or from an old file in the tree; if the docs cannot be read, ask the user to paste the `uses:` line from https://docs.getgreenroom.io/docs/quickstart/ios (or `/web`) and pass it as `--pin`.

Then draft. When the repository has no Greenroom setup yet, draft in place with `--out .` (the helper refuses to overwrite an existing setup file). When you are updating a setup, draft into a scratch directory and delete it after copying; it must never be left in the working tree:

```
node "<skill>/scripts/greenroom-onboard.mjs" draft . --out . \
  --app <slug> \
  --allowed-hosts <test-backend-host>,<cdn-host>,... \
  --production-hosts <prod-host>,<sdk-host>,... \
  --backend-host <test-backend-host> \
  --auth signed_out            # or session_import with the options in section 4
  [--sdk-keys REVENUECAT_API_KEY_IOS] [--exclude "/legal/*,/modals/*"] [--authenticated "/session,/upgrade"] [--entry "/onboarding"]
  [--bundle-id io.example.app] [--app-name Example] [--scheme Example] [--device "Greenroom QA Example"]
```

`--app` is the app's stable slug in Greenroom (lowercase, `a-z0-9._-`); the owner names the app the same in the Greenroom dashboard. The draft reads the pin, the framework, the router and the build from step 1 and writes:

- `.github/workflows/greenroom.yml`: one job that `uses:` Greenroom's reusable workflow at the pin. For iOS its `prepare` block builds the simulator app: Expo prebuild when `ios/` is generated, CocoaPods pinned to the lockfile's version (the hosted image refuses a lockfile from another version), a Release `xcodebuild` for the simulator, the `.app` copied to `build/`, and an embedded-bundle check. It is ad-hoc signed by default; never add `CODE_SIGNING_ALLOWED=NO` to a build that imports a session. For web it builds and serves the preview on 127.0.0.1:4173.
- `.greenroom/environment.json`: the attestation. iOS drafts use `sandboxed_backend` (the build is compiled against the isolated backend, so it cannot reach production by construction) with `resetStrategy: fresh_install`; web drafts use `playwright`.
- `.greenroom/state-contract.json`: one state per screen the router exposes (capped at 20; tab screens first, legal/modal/diagnostic screens dropped first; redirect-only routes never), each with `sources` set to the route file plus every project file it reaches through imports, `sharedSources` set to the layouts, the redirect-only routes and the files every screen imports (never a whole `src/components/**` by default: a change there would make every pull request a full pass), and `routerKind`/`graphPaths` when an extractor exists.

**The CocoaPods lockfile.** The hosted `macos-26` image ships one CocoaPods version and refuses a `Podfile.lock` written by another, and an unpinned `pod install` resolves pods differently from the owner's machine and from run to run. The draft therefore never writes an unpinned `pod install`, and the check refuses one. When `ios/` is generated and no `Podfile.lock` is tracked, the draft writes the recipe and placeholders instead, and the owner (or you, if you can run it) produces the lockfile once, locally:

```
npx expo prebuild --platform ios --no-install && pod install --project-directory=ios
mkdir -p .greenroom && cp ios/Podfile.lock .greenroom/Podfile.lock
```

Commit `.greenroom/Podfile.lock`; its last line (`COCOAPODS: X.Y.Z`) is the version to pin, and re-running the draft pins it. Until the file exists the check reports `podfile-lock-missing`, which is correct.

**Bundle id.** The draft uses the app's real bundle identifier from `app.json` (`expo.ios.bundleIdentifier`) or the Xcode project. That is right whenever the simulator build is the shipped build compiled against the test backend. Use a separate test bundle id (`io.example.qa`) only when the build itself must differ from the shipped one: a different associated-domain or push entitlement set, a second app already installed under the real id on shared simulators, or a store configuration keyed on the bundle id (RevenueCat, Firebase) that must not see test traffic. A different bundle id changes the Keychain access group the session import writes to, so the manifest's `target` still describes the app as built.

Now edit the draft by hand. This is the part that needs judgment:

- **Resolve every placeholder you can.** `REPLACE_WITH_ISOLATED_BACKEND_URL` in `prepare` (the build-time backend URL), `REPLACE_WITH_ISOLATED_BACKEND_HOST` in the hosts, `REPLACE_WITH_<SDK>_TEST_PROJECT_PUBLIC_SDK_KEY`, `REPLACE_WITH_COCOAPODS_VERSION`. The check names each one that is left. A value only the owner knows (the backend host, a test-project key) stays a placeholder and goes on the checklist; that is expected (section 5).
- **Curate the states.** Keep the core surfaces and the primary user outcome; 6 to 12 states is typical. Drop screens that need data the test account will not have, and screens the walk cannot reach (a deep link only). Add `variant` states where correctness matters most (empty state, error state). `--exclude` and re-drafting is fine, or edit the JSON.
- **Write observable goals.** Replace each drafted goal with what a user must achieve and what proves it: "Open Settings, switch Appearance to Dark, navigate to Today and back, and confirm Dark is still selected." A goal that "reaches" a screen proves nothing. The reference has a worked example of a completed-journey goal. If the app shows a system permission alert at first launch (notifications, tracking), the entry state's goal must say so and say the driver declines it (section 6).
- **Confirm `sources`.** The draft lists, for each state, the route file and every file it reaches through imports (relative imports, tsconfig `paths`, Expo's `@/`, babel aliases), collapsed to directory globs when more than 50. Read the list once: remove files that only happen to be imported (a logging helper), and add files reached in ways imports do not show (a screen selected by a string name, a native module). A file belongs on every state it backs. `sharedSources` holds the layouts, redirect-only routes, the files every screen imports and `.greenroom/**`; a change there widens the pass to every state, so add to it only what is truly global (the theme file, the design-system kit), never a whole components directory.
- **Mark the entry state** (`entryState`): where a fresh launch lands. Signed-out apps with a wall land on onboarding or sign-in; an imported session lands on the signed-in home.

### 4. Signed-in app: the session import block

Only for iOS apps whose session lives in the Keychain. Read `references/authenticated-apps.md` first; this section is the procedure, that file is the contract.

Find how the app reads its session on launch (the auth store's `initialize`, `bootstrap`, `hydrate`): which Keychain service and which keys, and whether one key (typically the refresh token) is enough for the app to sign itself in. The report lists the candidates; confirm in source. For `expo-secure-store` the service is the store's `keychainService` option followed by `:no-auth` (`app:no-auth` when there is no option), and the accounts are the keys passed to `setItemAsync`. For `react-native-keychain` and native code, the service and account strings the app queries. The runner writes the items with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`; an app that reads with any accessibility (the default for `expo-secure-store` and `react-native-keychain` reads) finds them, and a booted simulator is always past first unlock.

Draft with:

```
--auth session_import --secret GREENROOM_SESSION \
--accounts <refresh-token-key> [--service app:no-auth] [--target-kind expo-secure-store|keychain] \
[--authenticated "<route>,<route>,..."]
```

`--secret` is the NAME of the repository secret (A-Z, 0-9, _), never a value. The draft adds the manifest's `auth` block, the workflow's `secrets: session: ${{ secrets.<NAME> }}`, and `identity.authenticated: true` on every state under a gated layout and on every state that is reachable only from gated screens (a session screen pushed from the home tab; the report marks these "authenticated start inferred"). Confirm the inferred ones against the source; add any the inference missed with `--authenticated` or a hand edit. A state that claims a signed-in start under a `signed_out` manifest is rejected at preflight, before any spend.

**Remove every in-app session import path.** The build Greenroom walks must be the build you ship. The report's "In-app session import paths" lists what it found; grep yourself as well:

```
grep -rn -E 'greenroom-session|GREENROOM_QA|importSession|SessionBootstrap|SecItemAdd|launchArguments|ProcessInfo\.processInfo|SIMCTL_CHILD|getInitialURL' --include='*.ts' --include='*.tsx' --include='*.swift' --include='*.m' --include='*.py' --include='*.sh' .
```

Delete simulator-only importers, launch-argument or environment readers that seed a session, URL-scheme handlers that accept a token, debug endpoints that issue one, scripts that write a session file into the app container, and build steps that compile any of these into a test flavour. A `__DEV__`-only sign-in bypass is not compiled into a Release build; leave it if it is genuinely development-only, and say so in the summary. Greenroom writes the session into the simulator Keychain from outside the app before first launch; the app then refreshes it against the isolated backend the way it always does.

**Explain the issuance the owner must do.** The owner issues one disposable session for one disposable account on the isolated backend, using the backend's normal session issuer (the same function or endpoint sign-in calls; a test-only issuance endpoint that exists only on the isolated backend is fine), and stores it as the repository secret. The payload is one JSON object whose keys are exactly the declared accounts, for example `{ "<refresh-token-key>": "..." }`. It must be a refresh token or equivalent that survives a 45-minute job, never a production or personal account, never pasted into a file, a PR, a chat, or a workflow input. If the backend has no way to issue a session outside sign-in, say so: the owner has to add one on the isolated backend, not in the app.

**Rotating refresh tokens.** Read the backend's refresh handler. If a refresh token is single use (the backend rotates it and revokes the family when an old one is presented), the stored secret works for exactly one pass: the app rotates it during the first walk, and the second pass lands on the sign-in wall. Say so in the summary and put the two options on the checklist: (a) per-pass issuance, where the session is minted for each pass instead of stored once (available from the runner release after 0.3.16, as a `prepare`-issued session; until then the owner reissues the secret before each pass), or (b) a reuse allowance on the isolated backend for that one synthetic account (the backend's choice, never an app change). The reference names both.

### 5. Check

Run the check against the working tree (the three files in place):

```
node "<skill>/scripts/greenroom-onboard.mjs" check .
```

It validates the manifest and the contract against Greenroom's schemas, the workflow against the reusable workflow's inputs and the current pin, the cross-file rules (platform vs network control, `allowed-hosts` equal to the manifest, `secrets.session` present exactly when the manifest imports a session, authenticated claims backed by a mechanism, every state's `sources` matching a real file), the CocoaPods pin against the lockfile (and refuses an unpinned `pod install` or a missing lockfile), a private-looking value or the secrets context in `prepare`, and lists any remaining import path. Shell comments in `prepare` are ignored. Fix everything it names and rerun.

**The stopping point.** `"ready": true` is the goal, but a non-interactive run often cannot reach it: the isolated backend host and a test-project key are the owner's decisions, and the check refuses a placeholder by design. `"readyExceptPlaceholders": true` (every remaining issue has `code: "owner-placeholder"`, each named with its count) is therefore the expected end of your run. Stop there, list the placeholders in the summary, and do not invent values to make the check green. Anything else the check names (an import path, a missing lockfile, an unpinned pod install, a host mismatch) is yours to fix before stopping. The check cannot build the app or watch its network; those are the first pull request's job.

### 6. Stop with a diff and the owner checklist

Leave the three files in the working tree, uncommitted, with no draft directory left behind. Show the user the diff (`git diff` and the new files), and the summary:

1. What you detected (framework, router, wall, hosts, SDK keys) and what you decided, including which branch the diff is against and any earlier setup you reused.
2. What you removed (import paths) and what you left (dev-only bypasses) and why.
3. Startup system alerts. If the app requests a permission at launch (notifications, tracking, location), the first screen is the iOS alert, not the app: say so, state that the driver declines it (it never taps Allow), and confirm the entry goal says the same and that the app proceeds after a decline. An app that cannot be used without the permission granted is out of scope for the walk; say so instead of asking for a pre-grant, which the simulator does not support for notifications.
4. The owner checklist the helper printed, in this order:
   - Store the session payload as the repository secret named in the manifest (signed-in apps only), for a disposable account on the isolated backend the checklist names (the backend the session refreshes against, never the first host in the list), and the rotation decision if the backend rotates refresh tokens.
   - Provide a test-project public key for any SDK the app needs to start (`--sdk-keys`), through a GitHub Actions variable.
   - Produce and commit `.greenroom/Podfile.lock` if the check reported it missing.
   - Install the Greenroom GitHub App on the repository (read-only) and connect the repository in Greenroom under the same `app-id`.
   - **Merge the setup files into the base branch first.** Policy is read from the pull request's base revision; a PR cannot start a pass until they are there.
   - Open a separate test pull request that changes a mapped screen and read its Check and report. The first pass finds the hosts you forgot.
   - Cost: 20 free screen checks per workspace; after that pay-as-you-go ($49/month plus $1.50 per screen check), Team ($349/month, 400 included) or Scale ($999/month, 1,500 included). Only judged screens are charged; a pass is bounded at 20 screen checks and 10 minutes by default. https://docs.getgreenroom.io/docs/pricing
5. The placeholders left and the check's `readyExceptPlaceholders` result, and anything you could not decide alone, as specific questions (the isolated backend host, which screens matter most, the session issuer).

Do not commit or push, even if asked to "just finish it": the owner reviews the policy files because they are the owner's attestation about their own test environment.
