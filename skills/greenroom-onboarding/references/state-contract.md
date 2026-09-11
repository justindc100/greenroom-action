# The state contract (`.greenroom/state-contract.json`)

Public reference: https://docs.getgreenroom.io/docs/reference/state-contract

The contract names the screens Greenroom tests, what a user must achieve on each, and which source files render each one. With it, a pull request scopes to exactly the screens it changed and a clean run can conclude "the changed screens were covered and passed"; without it, coverage authority stays `requested-goal-only` and a clean run can never be better than `inconclusive`. Ship it at onboarding. Read from the PR's base revision like the manifest.

```json
{
  "schemaVersion": "1.0",
  "routerKind": "expo-router",
  "graphPaths": ["app"],
  "entryState": "/(tabs)/today",
  "sharedSources": ["app/_layout.tsx", "app/(tabs)/_layout.tsx", "app/index.tsx", "src/theme/**", ".greenroom/**"],
  "states": [
    {
      "id": "/(tabs)/today",
      "screen": "TodayScreen",
      "route": "/(tabs)/today",
      "identity": { "authenticated": true },
      "sources": ["app/(tabs)/today.tsx", "src/components/StatsCircles.tsx", "src/hooks/useStats.ts", "src/features/today/**"],
      "goal": "Land on Today signed in as the test account and confirm exactly one five-minute session is listed with reminders off."
    }
  ],
  "transitions": [
    { "id": "today-to-settings", "from": "/(tabs)/today", "to": "/(tabs)/settings", "action": { "kind": "tap", "target": "Settings" } }
  ]
}
```

## Top-level fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schemaVersion` | string | yes | `"1.0"`. |
| `fixture` | string | no | A label; unused by production. |
| `entryState` | string | no | The state a fresh launch lands on. Must be a declared state id. |
| `routerKind` | `"hash-spa" \| "expo-router" \| "react-navigation" \| "swiftui"` | with `graphPaths` | Which deterministic extractor rebuilds the screen graph from source (line-level scoping for hash-spa, expo-router and swiftui; file-level for react-navigation). |
| `graphPaths` | `string[]`, 1 to 20 | with `routerKind` | `expo-router`: the `app/` directory (or several route roots). `swiftui`: the target's source root. `hash-spa` and `react-navigation`: exactly one file, the one that defines the views object or declares the `<Stack.Screen>`s. |
| `sharedSources` | `string[]`, up to 100 globs | no | Files every screen depends on. A change matching one widens the pass to every state. |
| `states` | array, 1 to 20 | yes | The screens. |
| `transitions` | array, up to 400 | no | Edges between states, for the mapper's reasoning about what a changed screen can affect. Not an execution script. |

`routerKind` and `graphPaths` must be declared together; one without the other is a malformed contract, not an absent one. `routerKind` and `graphPaths` need source upload to be allowed for line-level scoping; `sources` globs work with source upload off, because attribution reads only the changed paths.

## States

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable identifier, referenced by transitions and reports. Route-shaped ids (`/(tabs)/today`) are conventional for routed apps. |
| `route` | string | no | The route or URL fragment that reaches it. |
| `screen` | string | no | The component or view name (`TodayScreen`, `CheckoutPage`). |
| `variant` | string | no | Distinguishes variants of one screen (`empty`, `error`, `post_first_session`). Each variant is its own state and lists the same `sources`. |
| `goal` | string, up to 2000 chars | no, but the check requires one | The actions and the observable outcome the driver must establish. Without one the driver only reaches and identifies the screen. |
| `identity` | object | no | Facts that identify the state in an observation. `{ "authenticated": true }` claims the walk starts signed in; it needs a `session_import` manifest. |
| `sources` | `string[]`, up to 50 globs | no, but the check requires at least one | Repository-relative globs of the files that render this state. |
| `oracle`, `setupTransitions` | | no | Research-fixture metadata; production does not execute them. Put expectations in `goal`. |

## Globs

`*` matches within one path segment, `**` matches across segments (including none: `src/**/Library.tsx` matches `src/Library.tsx`), `?` one character, a trailing `/` means everything under the directory. Case-sensitive, matched against the whole repository-relative path. A pattern that matches no file is an error the check reports.

## How a diff scopes

The runner sends the changed paths. Each is matched against every state's `sources`, then `sharedSources`:

- Matches one or more states only: a scoped pass over those states, no model call.
- Matches a shared glob: every state.
- Matches nothing: unmapped, and the pass widens exactly as an unmapped change always has.

So a file belongs on every state it backs (variants included); a state without `sources` is never attributed by path; and `sharedSources` should hold the layouts, the files every screen imports, and `.greenroom/**`, not every hook and service and never a whole components directory (each entry there makes more pull requests full passes; a `src/components/**` that holds feature components such as a paywall turns every component edit into a full pass).

How the draft derives them, for a routed app: it resolves each route file's imports transitively (relative paths, tsconfig `paths`, Expo's `@/`, babel `module-resolver` aliases) and lists the reached project files as that state's `sources` (collapsed to directory globs above 50); `sharedSources` is every layout file, every redirect-only route file, the intersection of the **kept** screens' closures (computed after `--exclude`, so an excluded debug route that imports only a database helper does not hide the theme file every real screen imports), design-token files wherever they live (`src/theme/**`, `src/constants/theme.ts`, a `tokens.ts` or `colors.ts` under `src/`), and the global stylesheets that imports cannot see (`tailwind.config.*`, `app/globals.css`); never a components directory. A route file whose only element is `<Redirect>` is not a screen: it is left out of `states` and its file goes to `sharedSources`, because changing where it sends users affects every entry. Confirm the lists rather than accept them: add what imports do not show (screens selected by string name, native modules), drop what only happens to be imported.

**Routes no navigation reaches.** The report marks each expo-router route with how a walk gets there: `tabs` (a tab bar shows it), `navigation` (another source file names it in a `router.push`, `href` or `Link`), `entry` (the root), or `none`. `none` is a deep link (`/invite/:code`), a debug screen nothing pushes (`/analytics`), or a route reached by a computed string the scan cannot see. A walk from `entryState` cannot reach a `none` route, so exclude it unless it is the entry or you know the navigation the scan missed; the draft sorts such routes last and names them.

Heuristics that draft well:

- **expo-router**: state per route file under `app/` (groups `(tabs)` kept in the id, `[param]` as `:param`, `index` dropped, redirect-only files skipped, routes no navigation reaches sorted last); `sources` = the route file plus its import closure plus `src/features/<name>/**` or `src/screens/<name>/**` when it exists; `sharedSources` = every `_layout.tsx`, the redirect-only routes, the design-token files, and what every kept screen imports. A route outside a gated layout that is referenced only from gated screens (`router.push("/session")` from a tab screen) is inferred to start authenticated when the manifest imports a session.
- **react-navigation**: state per `<X.Screen name=...>`, `sources` = the component file resolved through the navigator file's imports; `graphPaths` = that one navigator file.
- **SwiftUI**: state per `struct FooView: View` in a `Views`/`Screens` directory (skip small subviews); `sources` = its file plus its view model and the views it composes; `sharedSources` = `Sources/Theme/**`, the App and root ContentView files (not `Sources/Components/**` wholesale: list a component on the screens that use it); `graphPaths` = the target's source root.
- **Next app router**: state per `app/**/page.*`; `sources` = the page and its route directory; `sharedSources` = `app/layout.*`, `app/globals.css`, and the design-system primitives every page imports (`components/ui/**` only if every page really does).
- **Vite / custom web**: state per file under `src/pages`, `src/screens`, `src/views` or `src/routes`; `sharedSources` = `src/theme/**`, `src/index.css`, and what every page imports; components go on the pages that use them.

## Goals that prove something

The driver pursues each selected state's goal; the verification judge checks the evidence against it. "Reach Progress" can succeed by opening a tab with old history. State the actions and the new observable result:

> Inspect Progress and record the existing session count. Return to Today, start a session, complete every step, choose a 4-star rating, and press Finish session. Verify Progress now has one additional session and its newest row matches the exercise and selected rating. Navigate away and back and confirm that row remains. Existing history alone does not satisfy this goal.

Keep purchases, provider sign-in, sharing, invites, account deletion and external links out of goals unless the environment sandboxes them; say "do not" explicitly when a screen has such a control. The cap of 20 states is deliberate: the core surfaces and outcomes, not every screen.

## Startup system alerts

An app that requests a permission at launch (notifications, tracking, location, camera) shows an iOS system alert before its first screen, on every fresh install. The driver sees that alert as the whole screen: the observation is the alert's text and its buttons, nothing of the app behind it. The rule:

- **The driver never grants a permission.** Tapping "Allow" (or "Allow While Using App", "Allow Once", "OK" on a permission alert) is a policy denial, deterministic in the runner and repeated in the planner's instructions; a goal that needs the permission granted is reported as blocked, not attempted.
- **The driver may decline.** "Don't Allow", "Not Now", "Ask App Not to Track" and "Cancel" are ordinary taps. The walk continues on whatever the app shows after a decline.
- **The goal must say so.** For the entry state (and any state whose first action triggers an alert), write the alert into the goal: "On first launch, decline the notifications permission alert (Don't Allow), then confirm Today lists exactly one session." Without that sentence the driver has to guess whether the alert is part of the journey.
- **The app must work after a decline.** A screen that is unusable until the permission is granted is out of scope for the walk; say so instead of asking for a pre-grant. The simulator cannot pre-grant notifications (`simctl privacy grant notifications` is unsupported), and Greenroom does not modify the simulator's privacy database for a walk.
- **Leftover alerts are a state bug.** An alert an earlier walk did not dismiss survives uninstall and reinstall; `resetStrategy: fresh_install` covers the app's data, not SpringBoard's pending alerts, so goals should always dismiss what they trigger.
