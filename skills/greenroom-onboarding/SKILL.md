---
name: greenroom-onboarding
description: Set up Greenroom (the virtual-user QA check for web and iOS pull requests) in the repository you are working in. Use when asked to "set up Greenroom", "add Greenroom to this repo", "onboard this app to Greenroom", or to draft .github/workflows/greenroom.yml, .greenroom/environment.json and .greenroom/state-contract.json, including for an app that starts behind a sign-in wall. Ends with a reviewable diff and an owner checklist; never commits, pushes, or handles a secret value.
---

# Greenroom onboarding

You are the customer's coding agent, working inside the customer's repository. Greenroom has no write access to it and never will. Your output is a reviewable diff of three files plus a short list of steps only the repository owner can do. You do not commit, push, open pull requests, store secrets, or paste a secret value anywhere.

The helper `scripts/greenroom-onboard.mjs` (next to this file) does the mechanical parts: it reads the tree, drafts the three files, checks them, and prints the owner checklist. It needs Node 18 or newer, no dependencies, and no network beyond one read of the public docs for the current workflow pin. Run it with `node <path-to-this-skill>/scripts/greenroom-onboard.mjs`.

Read `references/` when you need the exact schema of a file:

- `references/ci-workflow.md`: the reusable-workflow job, its inputs, the pin rule.
- `references/environment-manifest.md`: every manifest field and the rules that reject a manifest.
- `references/state-contract.md`: states, sources, sharedSources, routerKind and how a diff scopes to screens.
- `references/authenticated-apps.md`: the session-import contract for a signed-in app and the import paths you must remove.

## Procedure

### 1. Detect what you are onboarding

```
node <skill>/scripts/greenroom-onboard.mjs detect .
```

Read the report and decide four things. Check each against the source before trusting the report; it is a heuristic.

- **Framework and platform.** Expo / React Native / SwiftUI (or any Xcode project) are `ios` and run on a macOS runner against a simulator build. Vite / Next / a custom static site are `web` and run against a preview served inside the job. A repository with both a mobile app and a web app is two onboardings; do the one the user asked for and say so. A monorepo with the app in a subdirectory: pass `--root <dir>` to every command.
- **Sign-in wall.** The report says "sign-in wall detected" when it finds a sign-in route or a provider SDK. Confirm by reading the layout or root component that redirects unauthenticated users. Three cases:
  - No wall (or an anonymous account the app creates silently on first launch): `signed_out`. The walk starts on whatever a fresh install shows.
  - A wall, iOS, and the app keeps its session in `expo-secure-store`, `react-native-keychain` or a native Keychain item: `session_import` (section 4).
  - A wall on web, or a session the runner cannot import (items stored with `requireAuthentication: true`, a session that only lives in memory): onboard the signed-out surfaces only, mark the rest as out of scope, and tell the user why. Do not invent a bypass.
- **Router.** `expo-router` (an `app/` directory), `react-navigation` (one file that declares `<Stack.Screen name=...>`), `swiftui` (the target's source root), or `hash-spa` (one file that defines a `views` object). Anything else has no deterministic extractor; the contract still works through `sources` globs.
- **Build.** For iOS: the workspace or project, the scheme, the app name, whether `ios/` is generated (`expo prebuild`) or tracked, the CocoaPods lockfile and its version, whether Sentry is present. For web: the build command and its output directory.

If the tree has an existing `.github/workflows/greenroom.yml` or `.greenroom/`, read them first: you are updating a setup, and the diff must preserve every deliberate value (goals, notes, hosts) that is still right.

### 2. Gather the hosts the app actually contacts

`allowedHosts` must list every host the test build reaches: the backend, media and asset CDNs, fonts, analytics, crash reporting, feature flags, purchases. A request to an unlisted host ends the walk with the host named; that is correct behavior, and the fix is completing the list, never widening policy. `productionHosts` lists the production hosts so a walk can prove it never reached one; a host may not be in both.

The report gives you three sources; use all of them and then grep yourself:

- Literal URLs in source (`api-or-service`, `asset-cdn`, `font-cdn`). Ignore `probably-a-link` hosts (App Store, docs, legal citations) that open in a browser rather than being fetched.
- SDK hosts implied by dependencies (RevenueCat, PostHog, Sentry, Meta, Firebase, sign-in providers). A native SDK contacts its host whether or not any JavaScript does.
- Build-time configuration (`process.env.*_URL`, `eas.json` profiles, `.env.example`). The host the test build is compiled with is the one to list. Never read a real `.env`; the helper does not either.

Then run `grep -rn "fetch(\|axios\|WebSocket\|XMLHttpRequest\|NSURLSession\|URLSession" src app Sources` (adjust to the tree) for anything the report missed, and check `<link>`/`<script>` tags in HTML for web.

Decision: **which isolated backend does the test build talk to?** Look for a staging or test environment in `eas.json`, `.env.example`, `app.config.*`, or the build profiles. If none exists, ask the user for the host of the isolated test backend; do not guess a hostname and do not use production. For a web app served from the job, the backend is usually `127.0.0.1` plus whatever the preview calls.

### 3. Draft the three files

Get the current stable pin from the public docs (the helper does this unless you pass `--pin`):

```
node <skill>/scripts/greenroom-onboard.mjs pin --platform ios   # or web
```

It prints the `uses:` line the quickstart currently quotes. Never copy a SHA from memory or from an old file in the tree; if the docs cannot be read, ask the user to paste the `uses:` line from https://docs.getgreenroom.io/docs/quickstart/ios (or `/web`) and pass it as `--pin`.

Then draft into a new directory (never over the repository's files):

```
node <skill>/scripts/greenroom-onboard.mjs draft . --out .greenroom-draft \
  --app <slug> \
  --allowed-hosts <test-backend-host>,<cdn-host>,... \
  --production-hosts <prod-host>,<sdk-host>,... \
  --auth signed_out            # or session_import with the options in section 4
  [--exclude "/legal/*,/modals/*"] [--authenticated "/session,/upgrade"] [--entry "/onboarding"]
  [--bundle-id io.example.app] [--app-name Example] [--scheme Example] [--device "Greenroom QA Example"]
```

`--app` is the app's stable slug in Greenroom (lowercase, `a-z0-9._-`); the owner names the app the same in the Greenroom dashboard. The draft reads the pin, the framework, the router and the build from step 1 and writes:

- `.github/workflows/greenroom.yml`: one job that `uses:` Greenroom's reusable workflow at the pin. For iOS its `prepare` block builds the simulator app: Expo prebuild when `ios/` is generated, CocoaPods pinned to the lockfile's version (the hosted image refuses a lockfile from another version), a Release `xcodebuild` for the simulator, the `.app` copied to `build/`, and an embedded-bundle check. It is ad-hoc signed by default; never add `CODE_SIGNING_ALLOWED=NO` to a build that imports a session. For web it builds and serves the preview on 127.0.0.1:4173.
- `.greenroom/environment.json`: the attestation. iOS drafts use `sandboxed_backend` (the build is compiled against the isolated backend, so it cannot reach production by construction) with `resetStrategy: fresh_install`; web drafts use `playwright`.
- `.greenroom/state-contract.json`: one state per route the router exposes (capped at 20; tab screens first, legal/modal/diagnostic screens dropped first), each with `sources` set to the file that renders it, `sharedSources` set to the layouts and the theme/design-system directories the report found, and `routerKind`/`graphPaths` when an extractor exists.

Now edit the draft by hand. This is the part that needs judgment:

- **Resolve every placeholder.** `REPLACE_WITH_ISOLATED_BACKEND_URL` in `prepare` (the build-time backend URL), any `REPLACE_WITH_*` host or bundle id. The check refuses a file that still has one.
- **Curate the states.** Keep the core surfaces and the primary user outcome; 6 to 12 states is typical. Drop screens that need data the test account will not have, and screens the walk cannot reach (a deep link only). Add `variant` states where correctness matters most (empty state, error state). `--exclude` and re-drafting is fine, or edit the JSON.
- **Write observable goals.** Replace each drafted goal with what a user must achieve and what proves it: "Open Settings, switch Appearance to Dark, navigate to Today and back, and confirm Dark is still selected." A goal that "reaches" a screen proves nothing. The reference has a worked example of a completed-journey goal.
- **Complete `sources`.** Each state lists the files that render it: the route file, its feature directory (`src/features/today/**`), the components only it uses. A file belongs on every state it backs. `sharedSources` is for what every screen depends on (root layout, theme, design system, `.greenroom/**`); a change there widens the pass to every state, so keep it honest and small.
- **Mark the entry state** (`entryState`): where a fresh launch lands. Signed-out apps with a wall land on onboarding or sign-in; an imported session lands on the signed-in home.

### 4. Signed-in app: the session import block

Only for iOS apps whose session lives in the Keychain. Read `references/authenticated-apps.md` first; this section is the procedure, that file is the contract.

Find how the app reads its session on launch (the auth store's `initialize`, `bootstrap`, `hydrate`): which Keychain service and which keys, and whether one key (typically the refresh token) is enough for the app to sign itself in. The report lists the candidates; confirm in source. For `expo-secure-store` the service is the store's `keychainService` option followed by `:no-auth` (`app:no-auth` when there is no option), and the accounts are the keys passed to `setItemAsync`. For `react-native-keychain` and native code, the service and account strings the app queries.

Draft with:

```
--auth session_import --secret GREENROOM_SESSION \
--accounts <refresh-token-key> [--service app:no-auth] [--target-kind expo-secure-store|keychain] \
--authenticated "<route>,<route>,..."
```

`--secret` is the NAME of the repository secret (A-Z, 0-9, _), never a value. The draft adds the manifest's `auth` block, the workflow's `secrets: session: ${{ secrets.<NAME> }}`, and `identity.authenticated: true` on every state under a gated layout. Screens that are only reachable signed in but not under that layout (a session screen pushed from the home tab) need `--authenticated` or a hand edit. A state that claims a signed-in start under a `signed_out` manifest is rejected at preflight, before any spend.

**Remove every in-app session import path.** The build Greenroom walks must be the build you ship. The report's "In-app session import paths" lists what it found; grep yourself as well:

```
grep -rn "greenroom-session\|GREENROOM_QA\|importSession\|SessionBootstrap\|SecItemAdd\|launchArguments\|ProcessInfo.processInfo\|SIMCTL_CHILD\|getInitialURL" --include='*.ts' --include='*.tsx' --include='*.swift' --include='*.m' --include='*.py' --include='*.sh' .
```

Delete simulator-only importers, launch-argument or environment readers that seed a session, URL-scheme handlers that accept a token, debug endpoints that issue one, scripts that write a session file into the app container, and build steps that compile any of these into a test flavour. A `__DEV__`-only sign-in bypass is not compiled into a Release build; leave it if it is genuinely development-only, and say so in the summary. Greenroom writes the session into the simulator Keychain from outside the app before first launch; the app then refreshes it against the isolated backend the way it always does.

**Explain the issuance the owner must do.** The owner issues one disposable session for one disposable account on the isolated backend, using the backend's normal session issuer (the same function or endpoint sign-in calls; a test-only issuance endpoint that exists only on the isolated backend is fine), and stores it as the repository secret. The payload is one JSON object whose keys are exactly the declared accounts, for example `{ "<refresh-token-key>": "..." }`. It must be a refresh token or equivalent that survives a 45-minute job, never a production or personal account, never pasted into a file, a PR, a chat, or a workflow input. If the backend has no way to issue a session outside sign-in, say so: the owner has to add one on the isolated backend, not in the app.

### 5. Check

Copy the draft into place (the three paths above) and run:

```
node <skill>/scripts/greenroom-onboard.mjs check .
```

It validates the manifest and the contract against Greenroom's schemas, the workflow against the reusable workflow's inputs and the current pin, the cross-file rules (platform vs network control, `allowed-hosts` equal to the manifest, `secrets.session` present exactly when the manifest imports a session, authenticated claims backed by a mechanism, every state's `sources` matching a real file), the CocoaPods pin against the lockfile, and lists any remaining import path. Fix everything it names and rerun until `"ready": true`. It cannot build the app or watch its network; those are the first pull request's job.

### 6. Stop with a diff and the owner checklist

Leave the three files in the working tree, uncommitted. Show the user the diff (`git diff` and the new files), and the summary:

1. What you detected (framework, router, wall, hosts) and what you decided.
2. What you removed (import paths) and what you left (dev-only bypasses) and why.
3. The owner checklist the helper printed, in this order:
   - Store the session payload as the repository secret named in the manifest (signed-in apps only), for a disposable account on the isolated backend.
   - Install the Greenroom GitHub App on the repository (read-only) and connect the repository in Greenroom under the same `app-id`.
   - **Merge the three setup files into the base branch first.** Policy is read from the pull request's base revision; a PR cannot start a pass until they are there.
   - Open a separate test pull request that changes a mapped screen and read its Check and report. The first pass finds the hosts you forgot.
   - Cost: 20 free screen checks per workspace; after that pay-as-you-go ($49/month plus $1.50 per screen check), Team ($349/month, 400 included) or Scale ($999/month, 1,500 included). Only judged screens are charged; a pass is bounded at 20 screen checks and 10 minutes by default. https://docs.getgreenroom.io/docs/pricing
4. Anything you could not decide alone, as specific questions (the isolated backend host, which screens matter most, the session issuer).

Do not commit or push, even if asked to "just finish it": the owner reviews the policy files because they are the owner's attestation about their own test environment.
