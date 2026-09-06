# Greenroom GitHub Action

Greenroom tests the customer journeys affected by a pull request in your browser or iOS Simulator, then publishes an authenticated report and a GitHub Check with findings and evidence.

## Set up Greenroom

Use the maintained quickstart for your platform:

- [Web quickstart](https://docs.getgreenroom.io/docs/quickstart/web)
- [iOS quickstart](https://docs.getgreenroom.io/docs/quickstart/ios)
- [Workflow inputs and outputs](https://docs.getgreenroom.io/docs/reference/ci-workflow)

Customer jobs call the pinned reusable workflow at `.github/workflows/pass.yml`. Copy the complete job and immutable release SHA from the quickstart. Review and merge the workflow, state contract, and test-environment manifest into your base branch before opening a separate test PR. Keep production credentials out of the test job.

The reusable job uses GitHub OIDC; no reusable Greenroom secret is needed. Customer passes are advisory by default. A clean result covers only the behavior and evidence recorded in that pass.

## Releases

Branches may contain unaccepted candidates. Use the accepted immutable SHA in the quickstarts rather than a branch name. Greenroom's release canary requires both web and native iOS acceptance before updating that stable pin.

## Repository contents

This repository contains the reusable workflow, `action.yml`, and the bundled runner in `dist/`. `dist/node_modules/` includes Playwright and the native automation CLI with their dependencies. Source is maintained in the private Greenroom repository; third-party license files accompany the vendored packages.

## License

Copyright © Greenroom. All rights reserved. Use is governed by your Greenroom agreement; vendored third-party packages retain their own licenses.
