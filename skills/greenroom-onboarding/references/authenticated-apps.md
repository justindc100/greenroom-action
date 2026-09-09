# Authenticated apps: the session-import contract

Public contract: https://docs.getgreenroom.io/docs/concepts/authenticated-apps

An app with a sign-in wall needs a session before Greenroom can inspect its authenticated screens. The job's OIDC token authenticates the runner to Greenroom; it does not sign the runner into the app. The one supported way for a signed-in iOS journey to start authenticated is **session import**: the owner issues a disposable session, stores it as one repository secret, and the runner writes it into the simulator Keychain from outside the app before first launch.

Two kinds of checks, and only the first is in scope:

| Check | Starting state | What it proves |
|---|---|---|
| Routine release journey | Disposable account with a valid session in an isolated backend | The signed-in behavior works for that account, role and entitlement |
| Sign-in journey | Signed out, using an approved provider test identity | The sign-in, cancellation, recovery or sign-out flow works |

Session import does not test Apple, Google, password, MFA or account creation; those, purchases, physical devices and credential entry by the virtual user are outside the contract. A synthetic subscription grants access for that test only.

## The manifest `auth` block

Absent means `{ "mechanism": "signed_out" }`.

```json
"auth": {
  "mechanism": "session_import",
  "secret": "GREENROOM_SESSION",
  "target": {
    "kind": "expo-secure-store",
    "service": "app:no-auth",
    "accounts": ["myapp_refresh_token"]
  },
  "reset": "fresh_install"
}
```

| Field | Meaning |
|---|---|
| `mechanism` | `signed_out` or `session_import`. No password, OTP or provider mechanism exists. |
| `secret` | The **name** of the repository secret that carries the payload (`A-Z`, `0-9`, `_`; 3 to 64 characters, starting with a letter). The manifest is stored with every run, so it never carries the value. Give the secret its own name; do not reuse one anything else reads. |
| `target.kind` | `expo-secure-store` for apps that persist their session with `expo-secure-store`; `keychain` for a plain generic-password item (`react-native-keychain`, a native `SecItemAdd`). |
| `target.service` | For `expo-secure-store`: the store's `keychainService` option followed by `:no-auth`; with no option, `app:no-auth`. Items stored with `requireAuthentication: true` cannot be imported. For `keychain`: the service string the app queries (`react-native-keychain` defaults to the bundle identifier). |
| `target.accounts` | The keys the app reads, 1 to 8, unique. For `expo-secure-store`, the keys passed to `setItemAsync`; for `keychain`, the account/username strings. Declare only what the app needs to sign itself in on launch: an app that refreshes from its refresh token needs only that key. |
| `target.accessGroup` | Optional. Only if the app reads its items from an explicit Keychain access group. By default the runner's writer is signed with the build's own entitlements and bundle identifier, so items land where the app's own writes go. |
| `reset` | Must be `fresh_install`, and `resetStrategy` must be `fresh_install`. Keychain items survive an uninstall, so the runner resets the simulator Keychain before every install; a stale session can never sign in silently. |

iOS only. A manifest that declares `session_import` for a web run is rejected. A state contract that claims a signed-in start (`identity.authenticated: true`) while the manifest is `signed_out` is rejected at preflight, before any spend.

## The workflow

```yaml
    secrets:
      session: ${{ secrets.GREENROOM_SESSION }}
```

under the job that `uses:` the reusable workflow, with the secret name the manifest declares. Leave it out for a `signed_out` manifest. If the manifest declares `session_import` and the secret is missing or is not the expected JSON object, the job stops at preflight with a named error and no run starts.

Note for `prepare`: the secret is passed to the runner step only; the `prepare` script does not see it. A backend that is created fresh inside the job cannot therefore accept a pre-issued session; the isolated backend must exist before the job and the session must be issued against it.

## The payload the owner stores

One JSON object whose keys are exactly the declared `accounts` and whose values are the strings the app expects there:

```json
{ "myapp_refresh_token": "rt_…" }
```

- A **disposable account on an isolated backend**: synthetic data only, minimal role, on the test or staging backend the `allowedHosts` name. Never production, never personal.
- **Issued by the backend's normal session issuer**: the same function or endpoint that sign-in calls (`createSession(userId)`, a test-only issuance endpoint that only exists on the isolated backend). No bypass in the app; no backend signing keys in the app or in Greenroom.
- **Long enough for a pass**: the job runs up to 45 minutes; a refresh token the app exchanges on launch is the right shape. A short-lived access token alone expires before the walk.
- Stored as a repository secret with the declared name; never in a workflow input, a file, a commit, a PR comment or a chat.
- Rotated on a schedule, and immediately if it was ever printed. Revoked, with the account's data deleted, when the account is retired; a revoked session makes the next pass stop at the sign-in wall, the correct signal to reissue.
- Separate accounts (and, if needed, separate manifests on separate branches) for free, entitled, expired and signed-out states.

## What the runner does

1. Validates the `auth` block and the payload before a run is minted (missing secret, undeclared account, non-string value: preflight errors, no spend).
2. Boots the named simulator, uninstalls any prior copy, installs the build, **resets the simulator Keychain**.
3. Compiles a small writer on the CI host, signs it ad hoc with the build's bundle identifier and keychain entitlements, runs it inside the simulator once: one generic-password item per account in the declared service, shaped as `expo-secure-store` (or a plain read) expects. It prints counts and status codes only.
4. Launches the app for the first time. The app finds its session the way it always does, refreshes against the isolated backend, lands on its signed-in screens.
5. Walks the requested screens. The payload appears in no argument, environment, log, report, screenshot or evidence object; the work directory is removed when the import finishes.

The runner never signs out, never purchases, never enters credentials, never modifies the app bundle.

## Rules the build must satisfy

- **No import path in the app.** The build Greenroom walks is the build you ship. Remove: simulator-only importers (`#if GREENROOM_QA`-style fragments, `importSession()` in an app delegate), launch arguments or environment reads that seed a session (`ProcessInfo.processInfo.arguments`, `SIMCTL_CHILD_*`), URL-scheme handlers that accept a token, debug endpoints that issue one, scripts that write a session file into the app container (`simctl get_app_container … Documents/session.json`), Keychain writers kept in the repository, and build steps that compile any of these into a test flavour. A `__DEV__`-only bypass that Release builds do not compile may stay; say so.
- **A signed simulator build.** Ad hoc ("Sign to Run Locally") is enough. `CODE_SIGNING_ALLOWED=NO` yields an unsigned build that cannot use the Keychain at all (`errSecMissingEntitlement`, -34018).
- **The app refreshes over an allowed host.** The backend the session belongs to is in `allowedHosts`; a refresh to any other host stops the walk.
- **A fresh `device` per job**, named in the workflow, not a simulator shared with other apps' state.

## Failures and their meaning

| What you see | Why | What to do |
|---|---|---|
| Preflight: `GREENROOM_SESSION is not set` | The workflow did not pass the `session` secret | Store the payload under the manifest's `secret` name and add `secrets: session:` to the job |
| Preflight: `state contract claims an authenticated start … no session import mechanism` | A state says `authenticated: true` but the manifest is `signed_out` | Declare `auth.mechanism: session_import`, or drop the claim |
| Preflight: `payload is missing a string value for account …` | The JSON object does not match `target.accounts` | Reissue with exactly the declared keys |
| Install: `the Keychain writer failed inside the simulator` | Unsigned build, or the simulator could not run the writer | Sign the simulator build; read the status code in the Actions log |
| Walk blocked at the sign-in wall | The app did not accept the imported session | Check the service and account names, the token's lifetime, and that the app refreshes against an allowed host |

## Worked example: an Expo app with `expo-secure-store`

`src/state/auth.ts` keeps `suelto_auth`, `suelto_token` and `suelto_refresh_token` with no `keychainService` option, and its `initialize()` refreshes from the refresh token alone when the other two are absent. Then:

- `target`: `{ "kind": "expo-secure-store", "service": "app:no-auth", "accounts": ["suelto_refresh_token"] }`
- payload: `{ "suelto_refresh_token": "<refresh token from createMobileSession(userId) on the staging backend>" }`
- states under `app/(tabs)/` and every screen pushed from them: `"identity": { "authenticated": true }`
- removed: `scripts/greenroom/SessionBootstrap.swift.txt`, `install-session.py`, `verify-bootstrap.py`, and the `GREENROOM_QA` insertion in `prepare-ios.py`; the app's own source never had an import path.
