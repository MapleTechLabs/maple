import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Effect, Option } from "effect"
import { Env } from "@maple/backend/platform/Env"
import {
	SlackIntegrationService,
	SLACK_CALLBACK_PATH,
} from "@maple/backend/services/integrations/SlackIntegrationService"

/** Redirect target on the web app after an install attempt. */
const buildAppRedirect = (appBaseUrl: string, params: Record<string, string>): string => {
	const base = appBaseUrl.replace(/\/$/, "")
	// Land on the Slack integration card (route `/integrations`, search `integration`),
	// carrying the `slack=connected|updated|error` return params the card surfaces as a toast.
	const search = new URLSearchParams({ integration: "slack", ...params }).toString()
	return `${base}/integrations?${search}`
}

/**
 * Public Slack OAuth callback (`GET /oauth/slack/callback`). Slack redirects the
 * browser here after the user approves (or denies) the install; we exchange the
 * code, persist the workspace, then redirect the browser back to the web app's
 * integrations page with a success/error query param.
 */
export const SlackCallbackRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const slack = yield* SlackIntegrationService
		const env = yield* Env

		const redirect = (params: Record<string, string>) =>
			HttpServerResponse.redirect(buildAppRedirect(env.MAPLE_APP_BASE_URL, params))

		const handle = Effect.fn("SlackOAuth.callback")(function* (req: HttpServerRequest.HttpServerRequest) {
			const urlOption = Option.liftThrowable(() => new URL(req.url, "http://localhost"))()
			if (Option.isNone(urlOption)) {
				return redirect({ slack: "error", slack_message: "Malformed callback URL" })
			}
			const url = urlOption.value
			const code = url.searchParams.get("code")
			const state = url.searchParams.get("state")
			const oauthError = url.searchParams.get("error")

			if (oauthError) {
				return redirect({ slack: "error", slack_message: oauthError })
			}
			if (!code || !state) {
				return redirect({ slack: "error", slack_message: "Missing code or state in callback" })
			}

			return yield* slack.completeInstall(code, state).pipe(
				Effect.tapError((error) =>
					Effect.logError("Slack OAuth completeInstall failed", {
						tag: error._tag,
						message: error.message,
					}),
				),
				Effect.map((result) =>
					redirect({
						// "updated" = an in-place re-auth of the org's active installation
						// (the permissions-refresh flow) — the web app toasts it differently
						// from a first-time connect.
						slack: result.updated ? "updated" : "connected",
						...(result.teamName ? { slack_team: result.teamName } : undefined),
					}),
				),
				Effect.catchTags({
					"@maple/http/errors/IntegrationsConfigurationError": () =>
						Effect.succeed(
							redirect({
								slack: "error",
								slack_message: "Slack integration is not configured in Maple",
							}),
						),
					"@maple/http/errors/IntegrationsValidationError": (error) =>
						Effect.succeed(redirect({ slack: "error", slack_message: error.message })),
					"@maple/http/errors/IntegrationsForbiddenError": (error) =>
						Effect.succeed(redirect({ slack: "error", slack_message: error.message })),
					"@maple/http/errors/IntegrationsUpstreamError": () =>
						Effect.succeed(
							redirect({
								slack: "error",
								slack_message: "Failed to complete the Slack connection",
							}),
						),
					"@maple/http/errors/IntegrationsPersistenceError": () =>
						Effect.succeed(
							redirect({
								slack: "error",
								slack_message: "Failed to complete the Slack connection",
							}),
						),
				}),
			)
		})

		yield* router.add("GET", SLACK_CALLBACK_PATH, handle)
	}),
)
