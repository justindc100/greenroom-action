# The CI workflow (`.github/workflows/greenroom.yml`)

Public reference: https://docs.getgreenroom.io/docs/reference/ci-workflow

One job that calls Greenroom's reusable workflow. Greenroom identifies a run by the workflow identity in the job's GitHub OIDC token (which workflow file ran, at which commit) and trusts only its own published commits. Because the job is defined in Greenroom's repository at a pinned commit, a pull request can change what gets built (the `prepare` script) but never what happens to the build afterwards. There is no Greenroom secret to store; the job proves itself over OIDC.

```yaml
name: Greenroom
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read

jobs:
  greenroom:
    permissions:
      contents: read
      id-token: write
    uses: justindc100/greenroom-action/.github/workflows/pass.yml@<stable pin>
    with:
      platform: ios            # or web
      app-id: my-app
      ...
    secrets:                   # signed-in iOS apps only
      session: ${{ secrets.GREENROOM_SESSION }}
```

## The pin

`uses:` names the reusable workflow at a full 40-character commit SHA. The stable pin is whatever the public quickstart currently quotes (https://docs.getgreenroom.io/docs/quickstart/web and `/ios` quote the same one); `greenroom-onboard.mjs pin` reads it. Never copy a SHA from memory, from another repository, or from an old file: Greenroom only accepts published commits, and the check compares the file's pin with the docs.

## Inputs (`with:`)

| Input | Platform | Meaning |
|---|---|---|
| `platform` | both | `web` or `ios`. Constrains which `networkControl` the manifest may declare. |
| `app-id` | both | The app's stable slug in Greenroom; the owner names the app the same in the dashboard. |
| `prepare` | both | Shell that builds and, for web, serves the preview. Runs inside the job with no credentials beyond OIDC. Background a server with `&`. |
| `target-url` | web | The preview URL to walk; its host must be in `allowedHosts`. The drafts use `http://127.0.0.1:4173/`. |
| `artifact-path` | both | The served directory (web) or the `.app` bundle (iOS). Its content digest attests what was walked. |
| `artifact-name` | iOS | Optional: a workflow artifact from a separate secretless build job, downloaded to `artifact-path` before the pass. |
| `app` | iOS | The bundle identifier of the simulator build. |
| `device` | iOS | The simulator name the reusable workflow finds or creates and boots before `prepare` runs (its UDID is exported as `GREENROOM_SIMULATOR_UDID`). Do not create a second simulator with the same name. |
| `runs-on` | both | `ubuntu-latest` (default) for web, `macos-26` for iOS. |
| `goal` | both | Optional bounded validation goal for the whole pass; the state contract's per-state goals are what the driver pursues. |
| `allowed-hosts` | iOS | Comma-separated allowlist; must equal the manifest's `allowedHosts`. |
| `environment-manifest`, `state-contract` | both | Paths inside the repository, default `.greenroom/environment.json` and `.greenroom/state-contract.json`, always read from the PR's base revision. |
| `source-upload-allowed` | both | `"false"` by default. Enable only after repository and Greenroom workspace policy have both been reviewed. Quote string-valued booleans. |

`secrets.session` is the only secret: the JSON session payload for a `session_import` manifest, from the repository secret the manifest names. Leave it out for a `signed_out` manifest.

## What the job does

1. Checks out the pull request and fetches the Greenroom runner at the same commit as the workflow file.
2. Reads the manifest and the state contract from the PR's **base** commit. A PR that edits `.greenroom/` still runs under the old policy; the new policy applies once it merges. This is why setup must be merged before the test PR.
3. Runs `prepare`.
4. Digests `artifact-path`.
5. (iOS, `session_import`) resets the simulator Keychain, installs the build fresh, writes the session from outside the app.
6. Runs the pass and posts the handoff as a GitHub Check run: success on a clean scoped pass, neutral otherwise. Advisory: it never blocks a merge.

## The iOS `prepare` block the draft writes

```bash
set -euo pipefail
export API_URL=https://api.staging.example.test     # the isolated backend, one export per build-time key the app reads
export SENTRY_DISABLE_AUTO_UPLOAD=true SENTRY_ALLOW_FAILURE=true   # when @sentry/react-native is present
npm ci --no-audit --no-fund
npx --no-install expo prebuild --platform ios --no-install         # when ios/ is generated (gitignored)
cp .greenroom/Podfile.lock ios/Podfile.lock                        # when the tracked lockfile lives outside ios/
sudo gem install cocoapods -v 1.16.2 --no-document                 # the lockfile's version
pod _1.16.2_ install --project-directory=ios --deployment
xcodebuild -workspace ios/Example.xcworkspace -scheme Example -configuration Release -sdk iphonesimulator -destination "generic/platform=iOS Simulator" -derivedDataPath "$RUNNER_TEMP/DerivedData" build
mkdir -p build && rm -rf build/Example.app && cp -R "$RUNNER_TEMP/DerivedData/Build/Products/Release-iphonesimulator/Example.app" build/Example.app
test -f build/Example.app/main.jsbundle
```

Rules behind it:

- **CocoaPods is pinned to the lockfile's version.** The hosted `macos-26` image ships CocoaPods 1.17.0 and refuses a `Podfile.lock` written by another version. The check reports `cocoapods-lockfile-drift` when nothing pins it.
- **`brew --prefix <formula>` succeeds for a formula that is not installed.** Install what the build needs or test `brew list --versions` first; the check reports `brew-formula-not-installed`.
- **Release configuration with the JS bundle embedded** (`main.jsbundle`): the simulator build must not depend on a Metro dev server.
- **Ad-hoc signed.** Xcode's default "Sign to Run Locally" is enough. `CODE_SIGNING_ALLOWED=NO` produces an unsigned build that cannot use the Keychain (`errSecMissingEntitlement`, -34018), which breaks a session import.
- **Sentry source-map upload** fails a secretless job ("Auth token is required"); `SENTRY_DISABLE_AUTO_UPLOAD=true` is that script's documented escape hatch.
- The job runs up to 45 minutes; hosted simulator boot and the XCTest runner build take several minutes before `prepare` even starts. Cache `Pods/` and DerivedData in a separate build job (`artifact-name`) if the build itself is slow.
