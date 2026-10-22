import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import {
	encodeOAuthReturnHash,
	type OAuthReturnFlow,
	validateIntegrationReturnPath,
} from "@maple/domain/http"
import { Effect, Option } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { PLANETSCALE_CALLBACK_PATH } from "@maple/backend/services/auth/PlanetScaleOAuthService"
import { SUPABASE_CALLBACK_PATH } from "@maple/backend/services/auth/SupabaseOAuthService"

export const HAZEL_CALLBACK_PATH = "/api/integrations/hazel/callback"
export const GITHUB_CALLBACK_PATH = "/api/integrations/github/callback"
export const CLOUDFLARE_CALLBACK_PATH = "/api/integrations/cloudflare/callback"

const HAZEL_MESSAGE_TYPE = "maple:integration:hazel"
const GITHUB_MESSAGE_TYPE = "maple:integration:github"
const CLOUDFLARE_MESSAGE_TYPE = "maple:integration:cloudflare"
const PLANETSCALE_MESSAGE_TYPE = "maple:integration:planetscale"
const SUPABASE_MESSAGE_TYPE = "maple:integration:supabase"

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
	// Theme tokens mirror apps/web/src/theme.css. The dashboard's light/dark
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

interface CallbackRoute {
	readonly path: HttpRouter.PathInput
	readonly flow: OAuthReturnFlow
	/** `maple.integration.provider` on the shared, fixed-name callback span. */
	readonly provider: string
	readonly label: string
	/** Where the dashboard finishes it: the page that mounts there, so its outcome is shown. */
	readonly page: "/integrations" | "/sources/new"
	readonly messageType: string
	/** Checks that need no session; a returned message refuses the callback here. */
	readonly precheck: (params: URLSearchParams) => string | null
}

const requireCodeAndState = (params: URLSearchParams): string | null =>
	params.get("code") && params.get("state") ? null : "Missing code or state in callback"

// `setup_action=request`: the org requires admin approval, so there is no installation yet.
const requireInstallation = (params: URLSearchParams): string | null =>
	!params.get("installation_id")
		? params.get("setup_action") === "request"
			? "Installation requested. An org admin must approve it on GitHub, then reconnect."
			: "Missing installation_id in callback"
		: !params.get("state")
			? "Missing state in callback. GitHub did not return it. Restart the connection from the Maple dashboard."
			: null

const ROUTES: ReadonlyArray<CallbackRoute> = [
	{
		path: HAZEL_CALLBACK_PATH,
		flow: "hazel",
		provider: "hazel",
		label: "Hazel",
		page: "/integrations",
		messageType: HAZEL_MESSAGE_TYPE,
		precheck: requireCodeAndState,
	},
	{
		path: GITHUB_CALLBACK_PATH,
		flow: "github",
		provider: "github",
		label: "GitHub",
		page: "/sources/new",
		messageType: GITHUB_MESSAGE_TYPE,
		precheck: requireInstallation,
	},
	{
		path: CLOUDFLARE_CALLBACK_PATH,
		flow: "cloudflare",
		provider: "cloudflare",
		label: "Cloudflare",
		page: "/sources/new",
		messageType: CLOUDFLARE_MESSAGE_TYPE,
		precheck: requireCodeAndState,
	},
	{
		path: PLANETSCALE_CALLBACK_PATH,
		flow: "planetscale",
		provider: "planetscale",
		label: "PlanetScale",
		page: "/sources/new",
		messageType: PLANETSCALE_MESSAGE_TYPE,
		precheck: requireCodeAndState,
	},
	{
		path: SUPABASE_CALLBACK_PATH,
		flow: "supabase",
		provider: "supabase",
		label: "Supabase",
		page: "/sources/new",
		messageType: SUPABASE_MESSAGE_TYPE,
		precheck: requireCodeAndState,
	},
]

/**
 * The provider callbacks. They redeem nothing: this request carries no Maple session, so it
 * cannot tell whose browser came back. The query goes to the dashboard in a URL fragment, and
 * the signed-in dashboard finishes it (`oauthComplete`), which only the starting user can do.
 */
export const IntegrationsCallbackRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const env = yield* Env
		const dashboardTargetOrigin = resolveDashboardTargetOrigin(env.MAPLE_APP_BASE_URL)
		const appBaseUrl = env.MAPLE_APP_BASE_URL.replace(/\/$/, "")

		const add = (route: CallbackRoute) => {
			const errorPage = (message: string) =>
				htmlResponse(
					renderCallbackPage({
						status: "error",
						message,
						returnTo: null,
						targetOrigin: dashboardTargetOrigin,
						messageType: route.messageType,
						label: route.label,
					}),
					400,
				)

			// Server-kind with the HTTP identity attributes stamped by hand: the auto server span is
			// suppressed for OAuth callbacks (the query carries the code and state), so this span is
			// the callback's only trace root. It carries the route and outcome, never the query.
			const handle = Effect.fn("IntegrationsCallbackRouter.oauthCallback", {
				kind: "server",
				attributes: {
					"http.route": route.path,
					"http.request.method": "GET",
					"maple.integration.provider": route.provider,
				},
			})(
				function* (req: HttpServerRequest.HttpServerRequest) {
					const urlOption = Option.liftThrowable(() => new URL(req.url, "http://localhost"))()
					if (Option.isNone(urlOption)) return errorPage("Malformed callback URL")
					const url = urlOption.value
					const oauthError = url.searchParams.get("error")
					if (oauthError) {
						return errorPage(
							url.searchParams.get("error_description") ||
								oauthError ||
								`${route.label} returned an error`,
						)
					}
					const refused = route.precheck(url.searchParams)
					if (refused !== null) return errorPage(refused)
					const search = new URLSearchParams({ integration: route.provider }).toString()
					const hash = encodeOAuthReturnHash({
						flow: route.flow,
						query: url.search.replace(/^\?/, ""),
					})
					return HttpServerResponse.redirect(`${appBaseUrl}${route.page}?${search}${hash}`)
				},
				// Every branch returns a response, so the status is the only signal of a rejection.
				Effect.tap((response) =>
					Effect.annotateCurrentSpan({ "http.response.status_code": response.status }),
				),
			)
			return router.add("GET", route.path, handle)
		}

		yield* Effect.forEach(ROUTES, add, { discard: true })
	}),
)
