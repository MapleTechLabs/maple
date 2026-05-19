import { Cause, Effect, Exit } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { GithubAppService } from "../services/GithubAppService"
import { GithubSyncQueue } from "../services/GithubSyncQueue"
import { GithubSyncService } from "../services/GithubSyncService"

const GITHUB_CALLBACK_PATH = "/api/integrations/github/callback"

const escapeHtml = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")

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

const renderCallbackPage = (params: {
	status: "success" | "error"
	message: string
	returnTo: string | null
}) => {
	const safeMessage = escapeHtml(params.message)
	const safeReturn = params.returnTo ? escapeHtml(params.returnTo) : null
	const payload = escapeJsonInHtml(
		JSON.stringify({
			type: "maple:integration:github",
			status: params.status,
			message: params.message,
		}),
	)
	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Maple — GitHub integration</title>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      body { font-family: -apple-system, system-ui, sans-serif; padding: 2rem; max-width: 28rem; margin: 0 auto; color: #111; }
      .ok { color: #047857; }
      .err { color: #b91c1c; }
      a.button { display: inline-block; margin-top: 1rem; background: #111; color: white; padding: 0.5rem 1rem; border-radius: 0.5rem; text-decoration: none; }
    </style>
  </head>
  <body>
    <h1 class="${params.status === "success" ? "ok" : "err"}">
      ${params.status === "success" ? "GitHub connected" : "GitHub connection failed"}
    </h1>
    <p>${safeMessage}</p>
    ${safeReturn ? `<p><a class="button" href="${safeReturn}">Return to Maple</a></p>` : ""}
    <script>
      try {
        if (window.opener) {
          window.opener.postMessage(${payload}, "*");
          setTimeout(function () { window.close(); }, 600);
        }
      } catch (_) {}
    </script>
  </body>
</html>`
}

const htmlResponse = (body: string, status?: number) => {
	const response = HttpServerResponse.html(body)
	return status === undefined ? response : HttpServerResponse.setStatus(response, status)
}

export const GithubCallbackRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const app = yield* GithubAppService
		const queue = yield* GithubSyncQueue
		const sync = yield* GithubSyncService

		const handle = (req: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				const url = new URL(req.url, "http://localhost")
				const state = url.searchParams.get("state")
				const installationIdRaw = url.searchParams.get("installation_id")
				const setupAction = url.searchParams.get("setup_action")
				const errorParam = url.searchParams.get("error")

				if (errorParam) {
					return htmlResponse(
						renderCallbackPage({
							status: "error",
							message:
								url.searchParams.get("error_description") || errorParam,
							returnTo: null,
						}),
						400,
					)
				}

				if (!state || !installationIdRaw) {
					return htmlResponse(
						renderCallbackPage({
							status: "error",
							message: "Missing state or installation_id in callback",
							returnTo: null,
						}),
						400,
					)
				}

				const installationId = Number(installationIdRaw)
				if (!Number.isFinite(installationId)) {
					return htmlResponse(
						renderCallbackPage({
							status: "error",
							message: "Invalid installation_id in callback",
							returnTo: null,
						}),
						400,
					)
				}

				const consumeExit = yield* Effect.exit(app.consumeState(state))
				if (Exit.isFailure(consumeExit)) {
					return htmlResponse(
						renderCallbackPage({
							status: "error",
							message: Cause.pretty(consumeExit.cause),
							returnTo: null,
						}),
						400,
					)
				}
				const ctx = consumeExit.value

				// Run reconcile inline so the installation + repo rows exist immediately.
				// (Queue.enqueue is unreliable in wrangler dev's local queue simulator.)
				const reconcileExit = yield* Effect.exit(
					sync.runReconcile({ orgId: ctx.orgId, installationId }),
				)
				if (Exit.isFailure(reconcileExit)) {
					return htmlResponse(
						renderCallbackPage({
							status: "error",
							message: `Failed to load installation from GitHub: ${Cause.pretty(reconcileExit.cause)}`,
							returnTo: ctx.returnTo,
						}),
						502,
					)
				}

				// Fire-and-forget: enqueue backfill jobs for each repo. Safe to fail.
				yield* queue.enqueue({
					_tag: "ReconcileInstallation",
					orgId: ctx.orgId,
					installationId,
				})

				const message =
					setupAction === "update"
						? "Configuration updated. Repositories refreshed."
						: "Installation complete. Repositories ready."

				return htmlResponse(
					renderCallbackPage({
						status: "success",
						message,
						returnTo: ctx.returnTo,
					}),
				)
			})

		yield* router.add("GET", GITHUB_CALLBACK_PATH, handle)
	}),
)
