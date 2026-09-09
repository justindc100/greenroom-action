# The environment manifest (`.greenroom/environment.json`)

Public reference: https://docs.getgreenroom.io/docs/reference/environment-manifest

The owner's attestation of what environment the virtual user may touch. Validated strictly (unknown fields are rejected) and always read from the pull request's base revision, so a PR cannot change its own policy.

```json
{
  "schemaVersion": "1.0",
  "classification": "test",
  "isolated": true,
  "resetStrategy": "fresh_install",
  "networkControl": "sandboxed_backend",
  "allowedHosts": ["api.staging.example.test", "cdn.example.test"],
  "productionHosts": ["api.example.com", "api.revenuecat.com", "us.i.posthog.com"],
  "sandboxPurchases": false,
  "notes": "Release simulator build pinned to the staging tenant.",
  "auth": { "mechanism": "signed_out" }
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schemaVersion` | `"1.0"` | yes | The literal `"1.0"`. |
| `classification` | `"preview" \| "staging" \| "test"` | yes | What kind of environment this is. |
| `isolated` | `true` | yes | The literal `true`: the environment holds no production data. There is no way to run against a non-isolated environment. |
| `resetStrategy` | `"fresh_install" \| "test_hook" \| "ephemeral_deployment"` | yes | How the app returns to a known state between walks. iOS requires `fresh_install`; web drafts use `ephemeral_deployment` (the preview is built inside the job). |
| `networkControl` | `"playwright" \| "external_proxy" \| "sandboxed_backend"` | yes | Web must declare `playwright` (the browser enforces the allowlist in-line). iOS accepts `sandboxed_backend` (recommended: the build is compiled against a test backend, so it cannot reach production by construction; Greenroom records but does not block simulator egress) or `external_proxy` (an egress proxy on the CI host denies everything else; strictest). |
| `allowedHosts` | `string[]`, 1 to 50 | yes | Every host the app may reach during a walk, including font CDNs, analytics and crash reporters. Host names only, no scheme or port. |
| `productionHosts` | `string[]`, up to 50 | no (default `[]`) | Production hosts, so a walk can prove it never touched one. |
| `sandboxPurchases` | boolean | no (default `false`) | Whether purchase flows run against a sandbox (StoreKit test configuration, Stripe test mode). Purchases also need a separate runner permission that is off by default. |
| `notes` | string, up to 1000 chars | no | Context for reviewers of the manifest. |
| `auth` | object | no (default `{ "mechanism": "signed_out" }`) | How a walk that starts behind a sign-in wall gets its session; see `authenticated-apps.md`. iOS only. |

## Rules that reject a manifest

- A host may not appear in both `allowedHosts` and `productionHosts` (case-insensitive). Rejected outright.
- Web runs must declare `playwright`; iOS runs must declare `sandboxed_backend` or `external_proxy`.
- iOS requires `resetStrategy: "fresh_install"`.
- `auth.mechanism: "session_import"` requires `resetStrategy: "fresh_install"` and `auth.reset: "fresh_install"`, and is refused for `platform: web`.
- Unknown fields anywhere are rejected.

## Rules that end a walk

- Any request to a host not in `allowedHosts` is contained and the walk ends with the violation and the host recorded. The fix is completing the allowlist. The number one first-run failure is a missing font or analytics host.
- iOS `allowed-hosts` in the workflow must equal the manifest's list, or the runner refuses to start.

## Deciding the lists

- `allowedHosts`: what the **test build** contacts. The isolated backend, its media/asset CDN, fonts (`fonts.googleapis.com` and `fonts.gstatic.com` for Google Fonts on web; bundled fonts on native need nothing), analytics and crash reporting if the test build has them configured (PostHog `us.i.posthog.com` or `eu.i.posthog.com`; Sentry `o<org>.ingest.<region>.sentry.io` from the DSN; RevenueCat `api.revenuecat.com`; Meta `graph.facebook.com`), feature flags, purchases sandbox hosts.
- `productionHosts`: the production backend and CDNs, and the same third-party hosts when the test build has them disabled (listing them there records the intent that the walk never reaches them).
- A third-party SDK that the test build leaves unconfigured (no key) usually makes no requests, and its host goes to `productionHosts`. One that is configured with a production key contacts its host and must be either allowlisted (with a test project) or unconfigured in the test build.
- **An SDK the app cannot start without.** Some initializers throw when their key is missing (RevenueCat's `configure` is one), and then the app's startup chain never runs: a blank screen, no auth initialization, no walk. Read the initializer. If it throws or blocks startup, the test build needs a **test project's public SDK key**, exported in `prepare` through a GitHub Actions variable (`--sdk-keys NAME` on the draft), and the SDK's host goes in `allowedHosts`. Public SDK keys (RevenueCat public keys, PostHog project tokens, Stripe publishable keys) ship inside the app binary and are allowed in `prepare`; a private key, secret, service-role or signing key never is, and `prepare` cannot read repository secrets at all. The alternative is an app-side guard that skips the SDK in a test build, which is app code and the owner's call.
- **Sentry without a DSN.** The ingest host (`o<org>.ingest.<region>.sentry.io`) is only knowable from the DSN. A test build compiled without a DSN sends nothing: list no Sentry host. Only when the test build carries a DSN (a public value the app ships with; never read it from `.env`) list its exact host.
