# Web e2e

Browser tests against a deployed Maple stack, written with Playwright's test runner
(`playwright/test`, shipped in the `playwright` package).
They catch what unit and component tests can't: a rule made by the API and edited in the UI,
a preview query that only fails on the deployed warehouse.

Run against a PR preview (signs in as the shared preview reviewer, see `docs/pr-previews.md`):

```bash
cd apps/web/e2e
bunx playwright install chromium   # once per Playwright version
MAPLE_E2E_APP_URL=https://app-pr-<n>.maple.dev \
  infisical run --env dev -- bunx playwright test
```

- `playwright.config.ts` has two projects: `setup` runs `tests/auth.setup.e2e.ts` once, and `web`
  runs every other test from the session it saved (`.auth/reviewer.json`, gitignored).
- `tests/auth.setup.e2e.ts` trades `PREVIEW_SIGNIN_KEY` for a single-use Clerk ticket in the
  runner, so the key never reaches the page.
- `tests/support.ts` `api()` calls the v2 API from the page with its Clerk session, for setup
  and for asserting what was saved.
- Inputs: `MAPLE_E2E_APP_URL` (default `http://localhost:3471`), `MAPLE_E2E_API_URL` (default: the
  app URL with `app-` swapped for `api-`), `MAPLE_E2E_NO_SYNC=1` to skip tests that need Electric
  sync (a `preview:web` preview).
- Tests create their own rules and destinations with a run-unique suffix and delete them after.
- `bunx playwright test --list` lists the suite without a browser or a stack.

CI runs this as the `e2e` job of `deploy-pr-preview.yml`, after the preview's seed and smoke test.
It is not a required check, and it reruns without redeploying. With `CI` set the config adds a
junit report (`.e2e/junit.xml`); it and screenshots of failures land in the `e2e-results`
artifact. Traces and videos stay off: a trace keeps request headers, which carry the reviewer's
session, and any repo reader can download the artifact. For a local trace, pass `--trace on`.
