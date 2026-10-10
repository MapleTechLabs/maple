import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { validateIntegrationReturnPath } from "@maple/domain/http"
import { Effect, Option } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { CloudflareAnalyticsService } from "@maple/backend/services/integrations/CloudflareAnalyticsService"
import { CloudflareOAuthService } from "@maple/backend/services/auth/CloudflareOAuthService"
import { PlanetScaleConnectionService } from "@maple/backend/services/integrations/PlanetScaleConnectionService"
import {
	PLANETSCALE_CALLBACK_PATH,
	PlanetScaleOAuthService,
} from "@maple/backend/services/auth/PlanetScaleOAuthService"
import { GithubConnectService } from "@maple/backend/services/integrations/vcs/vendor/github/GithubConnectService"
import { HazelOAuthService } from "@maple/backend/services/auth/HazelOAuthService"
import { summarizeCause } from "@maple/backend/platform/describe-cause"

export const HAZEL_CALLBACK_PATH = "/api/integrations/hazel/callback"
export const GITHUB_CALLBACK_PATH = "/api/integrations/github/callback"
export const CLOUDFLARE_CALLBACK_PATH = "/api/integrations/cloudflare/callback"

const HAZEL_MESSAGE_TYPE = "maple:integration:hazel"
const GITHUB_MESSAGE_TYPE = "maple:integration:github"
const CLOUDFLARE_MESSAGE_TYPE = "maple:integration:cloudflare"
const PLANETSCALE_MESSAGE_TYPE = "maple:integration:planetscale"

const escapeHtml = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")

// JSON.stringify does not escape `<` or `>`, so a payload value of
// `</script><script>alert(1)</script>` would terminate the inline script
// block. Escape these characters and the U+2028 / U+2029 line separators
// (which are valid line terminators in JS but not in JSON) before
// interpolating into a `<script>` body.
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

// The origin we send the popup's result to. It must match the dashboard's origin
// exactly or the browser drops the message, so we reduce MAPLE_APP_BASE_URL to just
// its origin. Falls back to "*" only if that URL can't be parsed.
const resolveDashboardTargetOrigin = (appBaseUrl: string): string =>
	Option.match(Option.liftThrowable(() => new URL(appBaseUrl))(), {
		onNone: () => "*",
		onSome: (parsed) => parsed.origin,
	})

/** Exported for the callback-page sink tests (`integrations-callback-page.test.ts`). */
export const renderCallbackPage = (params: {
	status: "success" | "error"
	message: string
	returnTo: string | null
	messageType: string
	label: string
	/** Origin the postMessage is sent to (the dashboard). */
	targetOrigin: string
}) => {
	const safeMessage = escapeHtml(params.message)
	// The stored return value is a dashboard-relative path, but this page is served
	// from the API origin — resolve it against the dashboard origin so the link works,
	// and drop it entirely when it is not a plain relative path (a `javascript:` URL
	// survives HTML escaping and would run here) or when the origin is unknown.
	const returnPath = validateIntegrationReturnPath(params.returnTo)
	const safeReturn =
		returnPath !== null && params.targetOrigin !== "*"
			? escapeHtml(`${params.targetOrigin}${returnPath}`)
			: null
	const blockedReturn = safeReturn === null && (params.returnTo ?? "").length > 0
	const payload = escapeJsonInHtml(
		JSON.stringify({
			type: params.messageType,
			status: params.status,
			message: params.message,
		}),
	)
	// Quote + escape it so the origin can't break out of the inline <script>.
	const targetOrigin = escapeJsonInHtml(JSON.stringify(params.targetOrigin))
	const isSuccess = params.status === "success"
	const glyph = isSuccess
		? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.5l5 5 10-11" /></svg>`
		: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>`
	// Theme tokens mirror apps/web/src/styles.css. The dashboard's light/dark
	// choice lives in localStorage on the web origin, which this API-origin
	// popup can't read — prefers-color-scheme is the closest proxy.
	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Maple — ${params.label} integration</title>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      :root {
        --background: oklch(1 0 0);
        --card: oklch(1 0 0);
        --foreground: oklch(0.141 0.005 285.823);
        --muted-foreground: oklch(0.552 0.016 285.938);
        --border: oklch(0.92 0.004 286.32);
        --primary: oklch(0.66 0.16 59);
        --primary-foreground: oklch(0.21 0.008 67);
        --destructive: oklch(0.577 0.245 27.325);
        --success: oklch(0.508 0.118 165.612);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --background: oklch(0.207 0.008 67);
          --card: oklch(0.224 0.009 75);
          --foreground: oklch(0.91 0.016 74);
          --muted-foreground: oklch(0.603 0.023 72);
          --border: oklch(0.268 0.012 67);
          --primary: oklch(0.714 0.154 59);
          --primary-foreground: oklch(0.207 0.008 67);
          --destructive: oklch(0.654 0.176 30);
          --success: oklch(0.765 0.177 163.223);
        }
      }
      * { box-sizing: border-box; }
      body {
        font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1.5rem;
        background: var(--background);
        color: var(--foreground);
      }
      .card {
        width: 100%;
        max-width: 28rem;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 2rem;
        text-align: center;
      }
      .glyph {
        width: 2.5rem;
        height: 2.5rem;
        margin: 0 auto 1rem;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        color: ${isSuccess ? "var(--success)" : "var(--destructive)"};
        background: color-mix(in oklch, currentColor 12%, transparent);
      }
      .glyph svg { width: 1.25rem; height: 1.25rem; }
      h1 { font-size: 1rem; font-weight: 600; margin: 0 0 0.5rem; }
      p { font-size: 0.8125rem; line-height: 1.5; color: var(--muted-foreground); margin: 0; }
      p.hint { margin-top: 0.75rem; opacity: 0.8; }
      a.button {
        display: inline-block;
        margin-top: 1.25rem;
        background: var(--primary);
        color: var(--primary-foreground);
        font: inherit;
        font-size: 0.8125rem;
        font-weight: 500;
        padding: 0.5rem 1rem;
        border-radius: 8px;
        text-decoration: none;
      }
      .wordmark {
        margin-top: 1.5rem;
        font-size: 0.6875rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted-foreground);
        opacity: 0.7;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="glyph">${glyph}</div>
      <h1>${isSuccess ? `${params.label} connected` : `${params.label} connection failed`}</h1>
      <p>${safeMessage}</p>
      ${isSuccess ? "" : `<p class="hint">Close this window and try connecting again from Maple.</p>`}
      ${
			safeReturn
				? `<a class="button" href="${safeReturn}">Return to Maple</a>`
				: blockedReturn
					? `<p class="hint" title="The return link was not a Maple dashboard path and was blocked.">Return link blocked — close this window and go back to Maple.</p>`
					: ""
		}
      <div class="wordmark">Maple</div>
    </main>
    <script>
      try {
        if (window.opener) {
          window.opener.postMessage(${payload}, ${targetOrigin});
          // Only a success closes itself. A failure's message is the one place the actual
          // cause is written out in full ("the OAuth app must grant offline_access", …) —
          // closing it after half a second leaves the user with a toast and no detail.
          ${isSuccess ? "setTimeout(function () { window.close(); }, 600);" : ""}
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

type CallbackPageParams = {
	status: "success" | "error"
	message: string
	returnTo: string | null
	targetOrigin: string
}

export const IntegrationsCallbackRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const hazel = yield* HazelOAuthService
		const github = yield* GithubConnectService
		const cloudflare = yield* CloudflareOAuthService
		const cloudflareAnalytics = yield* CloudflareAnalyticsService
		const planetscaleOAuth = yield* PlanetScaleOAuthService
		const planetscaleConnection = yield* PlanetScaleConnectionService
		const env = yield* Env

		const dashboardTargetOrigin = resolveDashboardTargetOrigin(env.MAPLE_APP_BASE_URL)
		const hazelCallbackPage = (params: Omit<CallbackPageParams, "targetOrigin">) =>
			renderCallbackPage({
				...params,
				targetOrigin: dashboardTargetOrigin,
				messageType: HAZEL_MESSAGE_TYPE,
				label: "Hazel",
			})
		const githubCallbackPage = (params: Omit<CallbackPageParams, "targetOrigin">) =>
			renderCallbackPage({
				...params,
				targetOrigin: dashboardTargetOrigin,
				messageType: GITHUB_MESSAGE_TYPE,
				label: "GitHub",
			})
		const cloudflareCallbackPage = (params: Omit<CallbackPageParams, "targetOrigin">) =>
			renderCallbackPage({
				...params,
				targetOrigin: dashboardTargetOrigin,
				messageType: CLOUDFLARE_MESSAGE_TYPE,
				label: "Cloudflare",
			})
		const planetscaleCallbackPage = (params: Omit<CallbackPageParams, "targetOrigin">) =>
			renderCallbackPage({
				...params,
				targetOrigin: dashboardTargetOrigin,
				messageType: PLANETSCALE_MESSAGE_TYPE,
				label: "PlanetScale",
			})

		const handle = Effect.fn("IntegrationsCallbackRouter.hazelOAuthCallback", {
			kind: "server",
			attributes: { "http.route": HAZEL_CALLBACK_PATH, "http.request.method": "GET" },
		})(function* (req: HttpServerRequest.HttpServerRequest) {
			const urlOption = Option.liftThrowable(() => new URL(req.url, "http://localhost"))()
			if (Option.isNone(urlOption)) {
				return htmlResponse(
					hazelCallbackPage({
						status: "error",
						message: "Malformed callback URL",
						returnTo: null,
					}),
					400,
				)
			}
			const url = urlOption.value
			const code = url.searchParams.get("code")
			const state = url.searchParams.get("state")
			const oauthError = url.searchParams.get("error")
			const oauthErrorDescription = url.searchParams.get("error_description") ?? oauthError

			if (oauthError) {
				return htmlResponse(
					hazelCallbackPage({
						status: "error",
						message: oauthErrorDescription || "Hazel returned an error",
						returnTo: null,
					}),
					400,
				)
			}

			if (!code || !state) {
				return htmlResponse(
					hazelCallbackPage({
						status: "error",
						message: "Missing code or state in callback",
						returnTo: null,
					}),
					400,
				)
			}

			return yield* hazel.completeConnect(code, state).pipe(
				// The callback page reduces failures to short human copy — make sure the real
				// cause still lands in the server log for diagnosis.
				Effect.tapError((error) =>
					Effect.logError("Hazel OAuth completeConnect failed", {
						tag: error._tag,
						message: error.message,
					}),
				),
				Effect.map((result) =>
					htmlResponse(
						hazelCallbackPage({
							status: "success",
							message: "You can close this window and return to Maple.",
							returnTo: result.returnTo,
						}),
					),
				),
				Effect.catchTag("@maple/http/errors/IntegrationsValidationError", (error) =>
					Effect.succeed(
						htmlResponse(
							hazelCallbackPage({
								status: "error",
								message: error.message,
								returnTo: null,
							}),
							400,
						),
					),
				),
				Effect.catchTags({
					"@maple/http/errors/IntegrationsUpstreamError": () =>
						Effect.succeed(
							htmlResponse(
								hazelCallbackPage({
									status: "error",
									message: "Failed to complete Hazel connection",
									returnTo: null,
								}),
								400,
							),
						),
					"@maple/http/errors/IntegrationsPersistenceError": () =>
						Effect.succeed(
							htmlResponse(
								hazelCallbackPage({
									status: "error",
									message: "Failed to complete Hazel connection",
									returnTo: null,
								}),
								400,
							),
						),
				}),
			)
		})

		yield* router.add("GET", HAZEL_CALLBACK_PATH, handle)

		// Server-kind with the HTTP identity attributes stamped by hand: the auto
		// server span is suppressed for OAuth callbacks (it would record the
		// authorization `code` and connect `state` in `url.full` / `url.query` —
		// see ApiObservabilityLive), so this span is the callback's only trace root.
		// It carries the route and outcome, never the query string.
		const handleGithub = Effect.fn("IntegrationsCallbackRouter.githubOAuthCallback", {
			kind: "server",
			attributes: { "http.route": GITHUB_CALLBACK_PATH, "http.request.method": "GET" },
		})(
			function* (req: HttpServerRequest.HttpServerRequest) {
				const urlOption = Option.liftThrowable(() => new URL(req.url, "http://localhost"))()
				if (Option.isNone(urlOption)) {
					return htmlResponse(
						githubCallbackPage({
							status: "error",
							message: "Malformed callback URL",
							returnTo: null,
						}),
						400,
					)
				}
				const url = urlOption.value
				const installationId = url.searchParams.get("installation_id")
				const setupAction = url.searchParams.get("setup_action")
				const state = url.searchParams.get("state")
				// Present only with OAuth-on-install enabled; proves the user owns the install.
				const code = url.searchParams.get("code") ?? undefined
				const oauthError = url.searchParams.get("error")
				const oauthErrorDescription = url.searchParams.get("error_description") ?? oauthError

				if (oauthError) {
					return htmlResponse(
						githubCallbackPage({
							status: "error",
							message: oauthErrorDescription || "GitHub returned an error",
							returnTo: null,
						}),
						400,
					)
				}

				// `setup_action=request` → the org requires admin approval; the
				// installation is pending and carries no usable installation_id yet.
				if (!installationId) {
					return htmlResponse(
						githubCallbackPage({
							status: "error",
							message:
								setupAction === "request"
									? "Installation requested — an org admin must approve it on GitHub, then reconnect."
									: "Missing installation_id in callback",
							returnTo: null,
						}),
						400,
					)
				}

				if (!state) {
					return htmlResponse(
						githubCallbackPage({
							status: "error",
							message:
								"Missing state in callback — GitHub did not return it. Restart the connection from the Maple dashboard.",
							returnTo: null,
						}),
						400,
					)
				}

				return yield* github.completeConnect(installationId, state, code).pipe(
					// The callback page reduces failures to short human copy — make sure the real
					// cause still lands in the server log for diagnosis.
					Effect.tapError((error) =>
						Effect.logError("GitHub OAuth completeConnect failed", {
							tag: error._tag,
							message: error.message,
						}),
					),
					Effect.map((result) =>
						htmlResponse(
							githubCallbackPage({
								status: "success",
								message: "You can close this window and return to Maple.",
								returnTo: result.returnTo,
							}),
						),
					),
					Effect.catchTags({
						"@maple/http/errors/IntegrationsValidationError": (error) =>
							Effect.succeed(
								htmlResponse(
									githubCallbackPage({
										status: "error",
										message: error.message,
										returnTo: null,
									}),
									400,
								),
							),
						"@maple/http/errors/IntegrationsUpstreamError": () =>
							Effect.succeed(
								htmlResponse(
									githubCallbackPage({
										status: "error",
										message: "Failed to complete GitHub connection",
										returnTo: null,
									}),
									400,
								),
							),
						"@maple/http/errors/IntegrationsPersistenceError": () =>
							Effect.succeed(
								htmlResponse(
									githubCallbackPage({
										status: "error",
										message: "Failed to complete GitHub connection",
										returnTo: null,
									}),
									400,
								),
							),
					}),
				)
			},
			// Every branch above returns a response rather than failing, so the status
			// is the only signal separating a completed connect from a rejection.
			Effect.tap((response) =>
				Effect.annotateCurrentSpan({ "http.response.status_code": response.status }),
			),
		)

		yield* router.add("GET", GITHUB_CALLBACK_PATH, handleGithub)

		const cloudflareErrorPage = (message: string) =>
			htmlResponse(cloudflareCallbackPage({ status: "error", message, returnTo: null }), 400)

		const handleCloudflare = Effect.fn("IntegrationsCallbackRouter.cloudflareOAuthCallback", {
			kind: "server",
			attributes: { "http.route": CLOUDFLARE_CALLBACK_PATH, "http.request.method": "GET" },
		})(function* (req: HttpServerRequest.HttpServerRequest) {
			const urlOption = Option.liftThrowable(() => new URL(req.url, "http://localhost"))()
			if (Option.isNone(urlOption)) {
				return cloudflareErrorPage("Malformed callback URL")
			}
			const url = urlOption.value
			const code = url.searchParams.get("code")
			const state = url.searchParams.get("state")
			const oauthError = url.searchParams.get("error")
			const oauthErrorDescription = url.searchParams.get("error_description") ?? oauthError

			if (oauthError) {
				return cloudflareErrorPage(oauthErrorDescription || "Cloudflare returned an error")
			}

			if (!code || !state) {
				return cloudflareErrorPage("Missing code or state in callback")
			}

			return yield* cloudflare.completeConnect(code, state).pipe(
				// The callback page reduces failures to short human copy — make sure the real
				// cause still lands in the server log for diagnosis.
				Effect.tapError((error) =>
					Effect.logError("Cloudflare OAuth completeConnect failed", {
						tag: error._tag,
						message: error.message,
					}),
				),
				// Reconnect writes fresh tokens, but rows a prior revoked-token error disabled
				// (`recordOrgError(..., { disable: true })`) have no other re-enable path for the
				// account-scoped workers anchor row — clear that state now so polling resumes
				// immediately instead of staying dead until something else touches the rows. This
				// must never fail the callback page: the connection itself already succeeded.
				Effect.tap((result) =>
					cloudflareAnalytics.resetOrgState(result.orgId).pipe(
						Effect.catchCause((cause) =>
							Effect.logWarning("cloudflare post-connect state reset failed", {
								orgId: result.orgId,
								error: summarizeCause(cause),
							}),
						),
					),
				),
				// The prime poll that fills the integration in (discovery + a first window)
				// deliberately does NOT run here. It used to, and it held the callback response —
				// so the popup sat blank for its whole budget after the user had already consented,
				// long enough to read as a hang and be closed, which aborted the poll and left a
				// lease behind. The dashboard calls `cloudflarePrime` instead, from a tab that
				// stays open and already renders the "finding your zones" phase while it runs.
				Effect.map((result) =>
					htmlResponse(
						cloudflareCallbackPage({
							status: "success",
							message: "You can close this window and return to Maple.",
							returnTo: result.returnTo,
						}),
					),
				),
				Effect.catchTags({
					// Validation/upstream messages are our own sanitized strings (they embed
					// Cloudflare's OAuth error text) — showing them turns "it failed" into
					// something actionable.
					"@maple/http/errors/IntegrationsValidationError": (error) =>
						Effect.succeed(cloudflareErrorPage(error.message)),
					"@maple/http/errors/IntegrationsUpstreamError": (error) =>
						Effect.succeed(cloudflareErrorPage(error.message)),
					"@maple/http/errors/IntegrationsRevokedError": () =>
						Effect.succeed(
							cloudflareErrorPage(
								"Cloudflare rejected the authorization — reconnect and try again",
							),
						),
					"@maple/http/errors/IntegrationsPersistenceError": () =>
						Effect.succeed(cloudflareErrorPage("Failed to complete Cloudflare connection")),
				}),
			)
		})

		yield* router.add("GET", CLOUDFLARE_CALLBACK_PATH, handleCloudflare)

		const planetscaleErrorPage = (message: string) =>
			htmlResponse(planetscaleCallbackPage({ status: "error", message, returnTo: null }), 400)

		const handlePlanetScale = Effect.fn("IntegrationsCallbackRouter.planetscaleOAuthCallback", {
			kind: "server",
			attributes: { "http.route": PLANETSCALE_CALLBACK_PATH, "http.request.method": "GET" },
		})(function* (req: HttpServerRequest.HttpServerRequest) {
			const urlOption = Option.liftThrowable(() => new URL(req.url, "http://localhost"))()
			if (Option.isNone(urlOption)) {
				return planetscaleErrorPage("Malformed callback URL")
			}
			const url = urlOption.value
			const code = url.searchParams.get("code")
			const state = url.searchParams.get("state")
			const oauthError = url.searchParams.get("error")
			const oauthErrorDescription = url.searchParams.get("error_description") ?? oauthError

			if (oauthError) {
				return planetscaleErrorPage(oauthErrorDescription || "PlanetScale returned an error")
			}

			if (!code || !state) {
				return planetscaleErrorPage("Missing code or state in callback")
			}

			return yield* planetscaleOAuth.completeConnect(code, state).pipe(
				// Single-org grants finish here (bind + provision the scrape target);
				// multi-org grants leave the org picker to the dashboard. A finalize
				// failure (e.g. missing read_metrics_endpoints scope) surfaces on the
				// callback page — this is the moment the user can act on it.
				Effect.flatMap((result) =>
					result.organizations.length === 1
						? planetscaleConnection
								.finalizeOrgSelection(result.orgId, {
									organization: result.organizations[0]!.name,
								})
								.pipe(
									Effect.map(() => ({
										returnTo: result.returnTo,
										message: `Connected to ${result.organizations[0]!.name}. You can close this window and return to Maple.`,
									})),
								)
						: Effect.succeed({
								returnTo: result.returnTo,
								message:
									"Authorization complete. Choose which PlanetScale organization to connect back in Maple.",
							}),
				),
				// The callback page reduces failures to short human copy — make sure the real
				// cause still lands in the server log for diagnosis.
				Effect.tapError((error) =>
					Effect.logError("PlanetScale OAuth completeConnect failed", {
						tag: error._tag,
						message: error.message,
					}),
				),
				Effect.map(({ returnTo, message }) =>
					htmlResponse(
						planetscaleCallbackPage({
							status: "success",
							message,
							returnTo,
						}),
					),
				),
				Effect.catchTags({
					"@maple/http/errors/IntegrationsConfigurationError": () =>
						Effect.succeed(
							planetscaleErrorPage("PlanetScale integration is not configured in Maple"),
						),
					// Validation/upstream messages are our own sanitized strings — showing
					// them turns "it failed" into something actionable.
					"@maple/http/errors/IntegrationsValidationError": (error) =>
						Effect.succeed(planetscaleErrorPage(error.message)),
					"@maple/http/errors/IntegrationsUpstreamError": (error) =>
						Effect.succeed(planetscaleErrorPage(error.message)),
					"@maple/http/errors/IntegrationsNotConnectedError": () =>
						Effect.succeed(
							planetscaleErrorPage(
								"PlanetScale connection not found — restart the connect flow",
							),
						),
					"@maple/http/errors/IntegrationsRevokedError": () =>
						Effect.succeed(
							planetscaleErrorPage(
								"PlanetScale rejected the authorization — reconnect and try again",
							),
						),
					"@maple/http/errors/IntegrationsPersistenceError": () =>
						Effect.succeed(planetscaleErrorPage("Failed to complete PlanetScale connection")),
				}),
			)
		})

		yield* router.add("GET", PLANETSCALE_CALLBACK_PATH, handlePlanetScale)
	}),
)
