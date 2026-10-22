import { ChatCompleteRequest, OAuthCompleteRequest } from "@maple/domain/http"
import { ChatConnectorId } from "@maple/domain/primitives"
import { Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { MapleInternalApiClient } from "../../platform/api-clients"
import { chatConnectorOf, integrationOfSearch } from "./catalog"
import { ConnectProvider, PROVIDERS } from "./connect"
import { Message } from "./message"
import type { Model } from "./model"

// A provider callback the API forwarded to this page (`?callback=`). The public callback completes
// nothing, because the browser that lands on it proves nothing about who started the connect;
// this page finishes it as the signed-in user, and the API refuses a session that did not start it.

export type ForwardedCallback =
	| { readonly kind: "oauth"; readonly provider: ConnectProvider }
	| { readonly kind: "chat-install" | "chat-identity"; readonly connector: ChatConnectorId }

export const forwardedCallbackOf = (search: Model["search"]): ForwardedCallback | null => {
	const integration = integrationOfSearch(search.integration)
	if (search.callback === "oauth") {
		return Schema.is(ConnectProvider)(integration) ? { kind: "oauth", provider: integration } : null
	}
	if (search.callback === "chat-install" || search.callback === "chat-identity") {
		const connector = integration === null ? null : chatConnectorOf(integration)
		return connector === null ? null : { kind: search.callback, connector }
	}
	return null
}

/**
 * The provider's query, read once and dropped from the address bar before anything else runs, so
 * the authorization code is in no history entry, bookmark or later `Referer`. Not a Foldkit
 * navigation: the route itself does not change.
 */
const takeFragment = Effect.sync(() => {
	const query = window.location.hash.replace(/^#/, "")
	window.history.replaceState(
		window.history.state,
		"",
		`${window.location.pathname}${window.location.search}`,
	)
	return query
})

/** The popup's opener is the page that started the connect; same origin only, like its listener. */
const relayToOpener = (provider: ConnectProvider, status: "success" | "error", message: string) =>
	Effect.sync(() => {
		const opener = window.opener
		if (opener === null || opener === window) return false
		opener.postMessage({ type: `maple:integration:${provider}`, status, message }, window.location.origin)
		return true
	})

const SUCCESS_CLOSE_DELAY = Duration.millis(600)

export const CompleteOAuthCallback = Command.define("CompleteIntegrationsOAuthCallback", {
	args: { provider: ConnectProvider },
	messages: [Message.CompletedOAuthCallback],
	execute: ({ provider }) =>
		Effect.gen(function* () {
			const query = yield* takeFragment
			const client = yield* MapleInternalApiClient
			const response = yield* client.integrations
				.oauthComplete({ payload: new OAuthCompleteRequest({ provider, query }) })
				.pipe(
					Effect.orElseSucceed(() => ({
						status: "error" as const,
						message: `Failed to complete the ${PROVIDERS[provider].label} connection`,
						returnTo: null,
					})),
				)
			const isRelayed = yield* relayToOpener(provider, response.status, response.message)
			// Only a success closes itself: a failure's message is the one place its cause is spelled out.
			if (isRelayed && response.status === "success") {
				yield* Effect.sleep(SUCCESS_CLOSE_DELAY)
				yield* Effect.sync(() => window.close())
			}
			return Message.CompletedOAuthCallback({
				provider,
				status: response.status,
				message: response.message,
				returnTo: response.returnTo,
				isRelayed,
			})
		}),
})

/** The outcome as the `/integrations` search the chat toast already reads (`chatCallbackOf`). */
const chatOutcomeSearch = (
	connector: ChatConnectorId,
	kind: "install" | "identity",
	outcome: {
		readonly status: "success" | "error"
		readonly reason: string | null
		readonly name: string | null
	},
): Record<string, string> => {
	const key = kind === "install" ? "chat" : "chat_identity"
	const nameKey = kind === "install" ? "chat_workspace" : "chat_identity_name"
	return {
		integration: `chat-${connector}`,
		[key]: outcome.status === "success" ? (kind === "install" ? "connected" : "linked") : "error",
		...(outcome.reason === null ? undefined : { chat_reason: outcome.reason }),
		...(outcome.name === null ? undefined : { [nameKey]: outcome.name }),
	}
}

export const CompleteChatCallback = Command.define("CompleteIntegrationsChatCallback", {
	args: { connector: ChatConnectorId, kind: Schema.Literals(["install", "identity"]) },
	messages: [Message.CompletedChatCallback],
	execute: ({ connector, kind }) =>
		Effect.gen(function* () {
			const query = yield* takeFragment
			const client = yield* MapleInternalApiClient
			const outcome = yield* client.integrations
				.chatComplete({ payload: new ChatCompleteRequest({ connector, kind, query }) })
				.pipe(
					Effect.orElseSucceed(() => ({ status: "error" as const, reason: "failed", name: null })),
				)
			return Message.CompletedChatCallback({ search: chatOutcomeSearch(connector, kind, outcome) })
		}),
})

/** One OutMessage per update: the toast first, then this strips the URL. */
export const StripCallback = Command.define("StripIntegrationsCallback", {
	args: { href: Schema.String },
	messages: [Message.StrippedCallback],
	execute: ({ href }) => Effect.succeed(Message.StrippedCallback({ href })),
})
