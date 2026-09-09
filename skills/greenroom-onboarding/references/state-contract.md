# The state contract (`.greenroom/state-contract.json`)

Public reference: https://docs.getgreenroom.io/docs/reference/state-contract

The contract names the screens Greenroom tests, what a user must achieve on each, and which source files render each one. With it, a pull request scopes to exactly the screens it changed and a clean run can conclude "the changed screens were covered and passed"; without it, coverage authority stays `requested-goal-only` and a clean run can never be better than `inconclusive`. Ship it at onboarding. Read from the PR's base revision like the manifest.

```json
{
  "schemaVersion": "1.0",
  "routerKind": "expo-router",
  "graphPaths": ["app"],
  "entryState": "/(tabs)/today",
  "sharedSources": ["app/_layout.tsx", "app/(tabs)/_layout.tsx", "src/theme/**", "src/components/**", ".greenroom/**"],
  "states": [
    {
      "id": "/(tabs)/today",
      "screen": "TodayScreen",
      "route": "/(tabs)/today",
      "identity": { "authenticated": true },
      "sources": ["app/(tabs)/today.tsx", "src/features/today/**"],
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

So a file belongs on every state it backs (variants included); a state without `sources` is never attributed by path; and `sharedSources` should hold the root layouts, the theme and design system, and `.greenroom/**`, not every hook and service (each entry there makes more pull requests full passes).

Heuristics that draft well:

- **expo-router**: state per route file under `app/` (groups `(tabs)` kept in the id, `[param]` as `:param`, `index` dropped); `sources` = the route file plus `src/features/<name>/**` or `src/screens/<name>/**` when it exists; `sharedSources` = every `_layout.tsx`, `src/theme/**`, `src/components/**`, `src/constants/theme.*`.
- **react-navigation**: state per `<X.Screen name=...>`, `sources` = the component file resolved through the navigator file's imports; `graphPaths` = that one navigator file.
- **SwiftUI**: state per `struct FooView: View` in a `Views`/`Screens` directory (skip small subviews); `sources` = its file plus its view model; `sharedSources` = `Sources/Theme/**`, `Sources/Components/**`, the App and root ContentView files; `graphPaths` = the target's source root.
- **Next app router**: state per `app/**/page.*`; `sources` = the page and its route directory; `sharedSources` = `app/layout.*`, `app/globals.css`, `components/ui/**`.
- **Vite / custom web**: state per file under `src/pages`, `src/screens`, `src/views` or `src/routes`; `sharedSources` = `src/theme/**`, `src/components/**`, `src/index.css`.

## Goals that prove something

The driver pursues each selected state's goal; the verification judge checks the evidence against it. "Reach Progress" can succeed by opening a tab with old history. State the actions and the new observable result:

> Inspect Progress and record the existing session count. Return to Today, start a session, complete every step, choose a 4-star rating, and press Finish session. Verify Progress now has one additional session and its newest row matches the exercise and selected rating. Navigate away and back and confirm that row remains. Existing history alone does not satisfy this goal.

Keep purchases, provider sign-in, sharing, invites, account deletion and external links out of goals unless the environment sandboxes them; say "do not" explicitly when a screen has such a control. The cap of 20 states is deliberate: the core surfaces and outcomes, not every screen.
