# Greenroom GitHub Action

Runs a Greenroom release pass from your CI: a virtual user walks the screens your pull request changed, on a real browser or iOS Simulator, and posts an evidence-backed QA handoff to the PR as a GitHub Check run.

This repository holds only the built runner (`dist/`) and its `action.yml`. Source lives in the private Greenroom repository; each commit here is a reviewed release of the runner bundle.

## Usage

Pin to a commit SHA, never a branch. Quickstarts and the field reference for the two config files live at https://docs.getgreenroom.io.

```yaml
- uses: justindc100/greenroom-action@<reviewed-commit-sha>
  with:
    greenroom-api-url: https://app.getgreenroom.io
    platform: web                      # or ios
    target-url: http://127.0.0.1:4173  # web preview; ios uses `app` instead
    environment-manifest: ${{ runner.temp }}/greenroom-environment.json
    state-contract: ${{ runner.temp }}/greenroom-state-contract.json
    base-sha: ${{ github.event.pull_request.base.sha }}
    head-sha: ${{ github.event.pull_request.head.sha }}
    workflow-ref: ${{ github.workflow_ref }}
    workflow-sha: ${{ github.workflow_sha }}
    pull-request-number: ${{ github.event.pull_request.number }}
```

The job needs `id-token: write` (the runner authenticates with GitHub Actions OIDC; there is no reusable Greenroom secret) and `contents: read`. Read the environment manifest and state contract from the PR's base revision, as the quickstart shows, so a pull request cannot loosen its own policy.

## Inputs and outputs

See [`action.yml`](action.yml). Outputs: `run-id`, `report-url`, `runner-verdict`.

## What ships in `dist/`

`dist/index.js` is the bundled runner. `dist/node_modules/` vendors `playwright-core` (web) and `agent-device` with its dependencies (iOS Simulator). Third-party licenses are listed in `dist/licenses.txt` and alongside each vendored package.

## License

Copyright © Greenroom. All rights reserved. Use of this action is governed by your Greenroom agreement; the vendored third-party packages keep their own licenses.
