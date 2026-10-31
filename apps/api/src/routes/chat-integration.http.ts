import { HttpRouter, HttpServerRequest } from "effect/http"
import { ChatConnectorId, encodeOAuthReturnHash, type OAuthReturnFlow } from "@maple/domain/http"
import { Effect, Option, Schema } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { forwardToDashboard } from "./integrations-callback.http"

/**
 * The two public callbacks every chat connector redirects to:
 * `GET /oauth/chat/:connector/callback` for the org's install, and
 * `GET /oauth/chat/:connector/identity/callback` for one person linking their own chat
 * account. The platform is a path *parameter*, so a new connector needs no new route.
 *
 * Neither redeems anything: the platform's top-level redirect carries no Maple session, so this
 * request cannot tell whose browser came back. The query goes to the dashboard in a URL fragment
 * and the signed-in dashboard finishes it (`oauthComplete`), for the user who started it only.
 */

const CHAT_CALLBACK_PATH = "/oauth/chat/:connector/callback"

const CHAT_IDENTITY_CALLBACK_PATH = "/oauth/chat/:connector/identity/callback"

const decodeConnectorParam = Schema.decodeUnknownOption(ChatConnectorId)

/** The dashboard's catalog id for a connector's card (`integration-catalog.tsx`). */
const cardId = (connector: string): string => `chat-${connector}`

export const ChatCallbackRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const env = yield* Env
		const appBaseUrl = env.MAPLE_APP_BASE_URL.replace(/\/$/, "")

		/** Where the browser lands: the integrations page, with the outcome or the return to finish. */
		const toDashboard = (search: Record<string, string>, hash = "") =>
			forwardToDashboard(`${appBaseUrl}/integrations?${new URLSearchParams(search).toString()}${hash}`)

		// Server-kind like `IntegrationsCallbackRouter`: the auto server span is suppressed for these
		// paths (ApiObservabilityLive), so this span is the callback's only trace root.
		const callback = (span: string, path: string, flow: OAuthReturnFlow, outcome: string) =>
			Effect.fn(span, {
				kind: "server",
				attributes: { "http.route": path, "http.request.method": "GET" },
			})(function* (req: HttpServerRequest.HttpServerRequest) {
				yield* Effect.annotateCurrentSpan({ "http.response.status_code": 302 })
				const routeParams = yield* HttpRouter.params
				const connector = decodeConnectorParam(routeParams.connector)
				const url = Option.liftThrowable(() => new URL(req.url, "http://localhost"))()
				// A closed reason code, never a message: the dashboard renders it inside a signed-in page.
				if (Option.isNone(connector))
					return toDashboard({ [outcome]: "error", chat_reason: "unknown" })
				if (Option.isNone(url)) {
					return toDashboard({
						integration: cardId(connector.value),
						[outcome]: "error",
						chat_reason: "failed",
					})
				}
				return toDashboard(
					{ integration: cardId(connector.value) },
					encodeOAuthReturnHash({
						flow,
						connector: connector.value,
						query: url.value.search.replace(/^\?/, ""),
					}),
				)
			})

		yield* router.add(
			"GET",
			CHAT_CALLBACK_PATH,
			callback("ChatOAuth.callback", CHAT_CALLBACK_PATH, "chat_install", "chat"),
		)
		yield* router.add(
			"GET",
			CHAT_IDENTITY_CALLBACK_PATH,
			callback(
				"ChatOAuth.identityCallback",
				CHAT_IDENTITY_CALLBACK_PATH,
				"chat_identity",
				"chat_identity",
			),
		)
	}),
)
