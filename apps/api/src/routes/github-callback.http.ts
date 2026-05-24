import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import type { OrgId } from "@maple/domain/http"
import { GithubAppService } from "../services/GithubAppService"
import { GithubSyncQueue } from "../services/GithubSyncQueue"
import { GithubSyncService } from "../services/GithubSyncService"

export const GITHUB_CALLBACK_PATH = "/api/integrations/github/callback"

// Matches the dark-mode `--background` token in apps/web/src/styles.css so the
// brief paint between popup-load and window.close() blends with the dashboard
// behind it instead of flashing white.
const DARK_BACKGROUND = "oklch(0.207 0.008 67)"

// GitHub's installation_id is an unsigned 64-bit integer. Match strictly so an
// empty or non-numeric param doesn't slip through `Number()` and reach the
// GitHub API as `0` or `NaN`.
const INSTALLATION_ID_PATTERN = /^[0-9]+$/

const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)
const escapeJsonInHtml = (json: string) =>
	json
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026")
		.split(LINE_SEPARATOR)
		.join("\\u2028")
		.split(PARAGRAPH_SEPARATOR)
		.join("\\u2029")

// Renders a blank dark page that immediately posts the result to the opening
// window and closes itself. The dashboard surfaces the success/error message
// inline; no UI is needed in the popup itself. If the page was opened in the
// same tab (no opener, e.g. popup blocked), it falls back to redirecting to
// `returnTo` so the user isn't stranded on a blank screen.
const renderCallbackPage = (
	status: "success" | "error",
	message: string,
	returnTo: string | null,
) => {
	const payload = escapeJsonInHtml(
		JSON.stringify({ type: "maple:integration:github", status, message }),
	)
	const returnToJson = escapeJsonInHtml(JSON.stringify(returnTo))
	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Maple</title>
    <style>html,body{margin:0;padding:0;height:100%;background:${DARK_BACKGROUND};}</style>
  </head>
  <body>
    <script>
      // Swallow cross-origin postMessage/close errors — they can happen in
      // edge popup-blocked or sandboxed-iframe scenarios, the user can't
      // act on them, and the parent app already reflects the outcome.
      try {
        if (window.opener) {
          window.opener.postMessage(${payload}, "*");
          window.close();
        } else {
          var returnTo = ${returnToJson};
          if (returnTo) window.location.replace(returnTo);
        }
      } catch (_) {}
    </script>
  </body>
</html>`
}

const renderError = (message: string, httpStatus: number, returnTo: string | null = null) =>
	HttpServerResponse.setStatus(
		HttpServerResponse.html(renderCallbackPage("error", message, returnTo)),
		httpStatus,
	)

const renderSuccess = (message: string, returnTo: string | null) =>
	HttpServerResponse.html(renderCallbackPage("success", message, returnTo))

export const GithubCallbackRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const app = yield* GithubAppService
		const queue = yield* GithubSyncQueue
		const sync = yield* GithubSyncService

		const enqueueInitialBackfill = Effect.fn("GithubCallbackRouter.enqueueInitialBackfill")(
			function* (installationDbId: string, orgId: OrgId) {
				const repos = yield* app.listRepositories(orgId, installationDbId)
				yield* queue.enqueueBackfills(
					repos.filter((r) => r.syncEnabled).map((repo) => ({ orgId, repoId: repo.id })),
				)
			},
		)

		const handle = (req: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
			const url = new URL(req.url, "http://localhost")
			const state = url.searchParams.get("state")
			const installationIdRaw = url.searchParams.get("installation_id")
			const setupAction = url.searchParams.get("setup_action")
			const errorParam = url.searchParams.get("error")

			if (errorParam) {
				return renderError(
					url.searchParams.get("error_description") || errorParam,
					400,
				)
			}

			if (!state || !installationIdRaw) {
				return renderError("Missing state or installation_id in callback", 400)
			}

			if (!INSTALLATION_ID_PATTERN.test(installationIdRaw)) {
				return renderError("Invalid installation_id in callback", 400)
			}
			const installationId = Number(installationIdRaw)

			// `Effect.result` keeps the typed error in `.failure` (vs. `Effect.exit`
			// which wraps it in a Cause and forces `Cause.pretty` — that leaks
			// internal fiber/stack noise and any sensitive cause-chain data into
			// the popup's postMessage payload). Pulling `.message` off the tagged
			// domain error keeps the wire output clean and user-readable.
			const consumeResult = yield* Effect.result(app.consumeState(state))
			if (consumeResult._tag === "Failure") {
				return renderError(consumeResult.failure.message, 400)
			}
			const ctx = consumeResult.success

			// Run reconcile inline so the installation + repo rows exist before
			// the popup closes — the dashboard re-fetches as soon as it sees
			// the postMessage and shouldn't show an empty card.
			const reconcileResult = yield* Effect.result(
				sync.runReconcile({ orgId: ctx.orgId, installationId }),
			)
			if (reconcileResult._tag === "Failure") {
				return renderError(
					`Failed to load installation from GitHub: ${reconcileResult.failure.message}`,
					502,
					ctx.returnTo,
				)
			}
			const { installation } = reconcileResult.success

			// Kick off commit backfill for each newly-synced repo. These run async
			// in the queue consumer (paginated, durable) so the callback responds
			// in under a second. Failures here don't roll back the successful
			// install — backfill being late just means commits resolve on-demand
			// via the unknown-sha job instead of being pre-populated.
			if (installation) {
				yield* enqueueInitialBackfill(installation.id, ctx.orgId).pipe(
					Effect.catchCause((cause) =>
						Effect.logError(
							`[github-callback] Initial backfill failed for installation ${installationId}`,
							cause,
						),
					),
				)
			}

			const message =
				setupAction === "update"
					? "Configuration updated. Repositories refreshed."
					: "Installation complete. Repositories ready."

			return renderSuccess(message, ctx.returnTo)
		})

		yield* router.add("GET", GITHUB_CALLBACK_PATH, handle)
	}),
)
