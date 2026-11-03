# Web e2e

Browser tests against a deployed Maple stack, written with [e2e](https://github.com/tester-army/e2e).
They catch what unit and component tests can't: a rule made by the API and edited in the UI,
a preview query that only fails on the deployed warehouse.

Run against a PR preview (signs in as the shared preview reviewer, see `docs/pr-previews.md`):

```bash
cd apps/web/e2e
E2E_TELEMETRY_DISABLED=1 MAPLE_E2E_APP_URL=https://app-pr-<n>.maple.dev \
  infisical run --env dev -- bunx e2e run
```

- `tests/auth.setup.e2e.ts` trades `PREVIEW_SIGNIN_KEY` for a single-use Clerk ticket in the
  runner, so the key never reaches the page, a trace, or a model.
- `tests/support.ts` `api()` calls the v2 API from the page with its Clerk session, for setup
  and for asserting what was saved.
- Assert with locators and `expect`. No model is configured, so `agent.*` steps are unavailable.
- Tests create their own rules and destinations with a run-unique suffix and delete them after.

CI runs this as the `e2e` job of `deploy-pr-preview.yml`, after the preview's seed and smoke test.
It is not a required check, and it reruns without redeploying. Traces and screenshots land in
the `e2e-results` artifact.
