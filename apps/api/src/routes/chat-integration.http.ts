import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { ChatConnectorId } from "@maple/domain/http"
import { Effect, Option, Schema } from "effect"
import { Env } from "@maple/backend/platform/Env"
import {
	callbackQueryOf,
	dashboardCallbackUrl,
	type DashboardCallbackKind,
	forwardToDashboard,
} from "./integrations-callback.http"

/**
 * The two public callbacks every chat connector redirects to:
 * `GET /oauth/chat/:connector/callback` for the org's install, and
 * `GET /oauth/chat/:connector/identity/callback` for one person linking their own chat
 * account. The platform is a path *parameter*, so a new connector needs no new route — it
 * registers in the connector registry and these handlers resolve it by id.
 *
 * Neither completes anything. The platform issues a top-level redirect, so the browser that lands
 * here proves nothing about who started the install or link; the query is forwarded to the
 * dashboard, which finishes it through `chatComplete` as the signed-in user, and the state row is
 * redeemed only when that user and org started it.
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

		const callback = (span: string, kind: DashboardCallbackKind, outcome: string) =>
			Effect.fn(span)(function* (req: HttpServerRequest.HttpServerRequest) {
				// Every branch is a 302: this span is the callback's only trace root (ApiObservabilityLive).
				yield* Effect.annotateCurrentSpan({ "http.response.status_code": 302 })
				const routeParams = yield* HttpRouter.params
				const connector = decodeConnectorParam(routeParams.connector)
				if (Option.isNone(connector)) {
					const search = new URLSearchParams({ [outcome]: "error", chat_reason: "unknown" })
					return HttpServerResponse.redirect(`${appBaseUrl}/integrations?${search.toString()}`)
				}
				yield* Effect.annotateCurrentSpan({ "maple.chat.connector": connector.value })
				return forwardToDashboard(
					dashboardCallbackUrl(appBaseUrl, cardId(connector.value), kind, callbackQueryOf(req)),
				)
			})

		yield* router.add("GET", CHAT_CALLBACK_PATH, callback("ChatOAuth.callback", "chat-install", "chat"))
		yield* router.add(
			"GET",
			CHAT_IDENTITY_CALLBACK_PATH,
			callback("ChatOAuth.identityCallback", "chat-identity", "chat_identity"),
		)
	}),
)
