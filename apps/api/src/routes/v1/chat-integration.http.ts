import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ChatConnectorId } from "@maple/domain/http"
import { Effect, Option, Schema } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { ChatWorkspaceService } from "@maple/backend/services/integrations/ChatWorkspaceService"

/**
 * The two public callbacks every chat connector redirects to:
 * `GET /oauth/chat/:connector/callback` for the org's install, and
 * `GET /oauth/chat/:connector/identity/callback` for one person linking their own chat
 * account. The platform is a path *parameter*, so a new connector needs no new route — it
 * registers in the connector registry and these handlers resolve it by id.
 *
 * The browser lands here after the user approves (or declines). The connector turns the query
 * into a linked workspace or a linked account, and the browser goes back to the dashboard's
 * integrations page with the outcome. Both are unauthenticated: the platform issues a top-level
 * redirect, so there is no session to require, and the single-use state row carries everything
 * the completion needs.
 */

const CHAT_CALLBACK_PATH = "/oauth/chat/:connector/callback"

const CHAT_IDENTITY_CALLBACK_PATH = "/oauth/chat/:connector/identity/callback"

const decodeConnectorParam = Schema.decodeUnknownOption(ChatConnectorId)

/**
 * Outcome as a closed set of codes rather than a message: the dashboard renders
 * this inside an authenticated page, and a backend- or provider-authored string
 * echoed there is a phishing surface. The web maps each code to its own copy.
 */
type ChatCallbackReason = "state" | "conflict" | "unconfigured" | "unknown" | "failed"

/** Where the browser lands afterwards: the connector's card, plus the outcome. */
const buildAppRedirect = (appBaseUrl: string, params: Record<string, string>): string => {
	const base = appBaseUrl.replace(/\/$/, "")
	return `${base}/integrations?${new URLSearchParams(params).toString()}`
}

/** The dashboard's catalog id for a connector's card (`integration-catalog.tsx`). */
const cardId = (connector: string): string => `chat-${connector}`

export const ChatCallbackRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const chat = yield* ChatWorkspaceService
		const env = yield* Env

		const redirect = (params: Record<string, string>) =>
			HttpServerResponse.redirect(buildAppRedirect(env.MAPLE_APP_BASE_URL, params))

		const failed = (connector: string, reason: ChatCallbackReason) =>
			redirect({ integration: cardId(connector), chat: "error", chat_reason: reason })

		/** The identity half's outcome, under its own param and the same reason codes. */
		const identityFailed = (connector: string, reason: ChatCallbackReason) =>
			redirect({ integration: cardId(connector), chat_identity: "error", chat_reason: reason })

		const requestUrl = (req: HttpServerRequest.HttpServerRequest) =>
			Option.liftThrowable(() => new URL(req.url, "http://localhost"))()

		const handle = Effect.fn("ChatOAuth.callback")(function* (req: HttpServerRequest.HttpServerRequest) {
			const routeParams = yield* HttpRouter.params
			const connectorOption = decodeConnectorParam(routeParams.connector)
			if (Option.isNone(connectorOption)) {
				return redirect({ chat: "error", chat_reason: "unknown" satisfies ChatCallbackReason })
			}
			const connector = connectorOption.value
			const urlOption = requestUrl(req)
			if (Option.isNone(urlOption)) {
				return failed(connector, "failed")
			}

			// The whole query string goes to the connector: which parameters carry
			// the authorization is the connector's business, not this route's.
			return yield* chat.completeInstall(connector, urlOption.value.searchParams).pipe(
				Effect.tapError((error) =>
					Effect.logError("Chat install callback failed", {
						connector,
						tag: error._tag,
						message: error.message,
					}),
				),
				Effect.map((result) =>
					redirect({
						integration: cardId(connector),
						chat: "connected",
						chat_workspace: result.name,
					}),
				),
				Effect.catchTags({
					"@maple/http/errors/IntegrationsValidationError": () =>
						Effect.succeed(failed(connector, "state")),
					"@maple/http/errors/IntegrationsForbiddenError": () =>
						Effect.succeed(failed(connector, "conflict")),
					"@maple/http/errors/IntegrationsNotFoundError": () =>
						Effect.succeed(failed(connector, "unknown")),
					"@maple/http/errors/IntegrationsConfigurationError": () =>
						Effect.succeed(failed(connector, "unconfigured")),
					"@maple/http/errors/IntegrationsUpstreamError": () =>
						Effect.succeed(failed(connector, "failed")),
					"@maple/http/errors/IntegrationsPersistenceError": () =>
						Effect.succeed(failed(connector, "failed")),
				}),
			)
		})

		const handleIdentity = Effect.fn("ChatOAuth.identityCallback")(function* (
			req: HttpServerRequest.HttpServerRequest,
		) {
			const routeParams = yield* HttpRouter.params
			const connectorOption = decodeConnectorParam(routeParams.connector)
			if (Option.isNone(connectorOption)) {
				return redirect({
					chat_identity: "error",
					chat_reason: "unknown" satisfies ChatCallbackReason,
				})
			}
			const connector = connectorOption.value
			const urlOption = requestUrl(req)
			if (Option.isNone(urlOption)) {
				return identityFailed(connector, "failed")
			}

			return yield* chat.completeLink(connector, urlOption.value.searchParams).pipe(
				Effect.tapError((error) =>
					Effect.logError("Chat account link callback failed", {
						connector,
						tag: error._tag,
						message: error.message,
					}),
				),
				Effect.map((result) =>
					redirect({
						integration: cardId(connector),
						chat_identity: "linked",
						// The platform's own display string, and only when it reported one.
						// Untrusted, like the workspace name — the page clamps it.
						...(result.displayName === undefined
							? undefined
							: { chat_identity_name: result.displayName }),
					}),
				),
				Effect.catchTags({
					"@maple/http/errors/IntegrationsValidationError": () =>
						Effect.succeed(identityFailed(connector, "state")),
					"@maple/http/errors/IntegrationsNotFoundError": () =>
						Effect.succeed(identityFailed(connector, "unknown")),
					"@maple/http/errors/IntegrationsConfigurationError": () =>
						Effect.succeed(identityFailed(connector, "unconfigured")),
					"@maple/http/errors/IntegrationsUpstreamError": () =>
						Effect.succeed(identityFailed(connector, "failed")),
					"@maple/http/errors/IntegrationsPersistenceError": () =>
						Effect.succeed(identityFailed(connector, "failed")),
				}),
			)
		})

		yield* router.add("GET", CHAT_CALLBACK_PATH, handle)
		yield* router.add("GET", CHAT_IDENTITY_CALLBACK_PATH, handleIdentity)
	}),
)
