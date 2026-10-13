// BOUNDARY: this module reads a Durable Object namespace off a Worker env, a value nothing has parsed.
/**
 * Reaching a conversation's relay object.
 *
 * Deliberately tiny and free of the relay itself: this is imported by the ingress path, which runs
 * on every frame, while everything the relay does is behind the object's own dynamic import.
 */
import type { InboundEvent } from "@maple/chat-platform"
import * as Cloudflare from "alchemy/Cloudflare"
import type { Effect } from "effect"

/** The relay's RPC surface, as an alchemy Effect stub sees it. */
export interface ConnectorRelayRemote {
	readonly deliver: (event: InboundEvent) => Effect.Effect<void>
	/**
	 * Record that the bot opened this conversation, on the object that will handle its later
	 * messages, which is not the one handling the message that opened it.
	 */
	readonly remember: (conversationKey: string) => Effect.Effect<void, unknown>
}

/** The alchemy namespace client the Worker and the socket object yield (`ConnectorRelayObject`). */
export interface ConnectorRelayClient {
	readonly getByName: (name: string) => Pick<ConnectorRelayRemote, "deliver">
}

interface ConnectorRelayNamespace {
	readonly idFromName: (name: string) => unknown
	readonly get: (id: unknown) => unknown
}

const isRelayNamespace = (value: unknown): value is ConnectorRelayNamespace =>
	typeof value === "object" &&
	value !== null &&
	"get" in value &&
	typeof value.get === "function" &&
	"idFromName" in value &&
	typeof value.idFromName === "function"

/**
 * Which object handles an event: one per conversation, or one per workspace for an event that has
 * no conversation.
 *
 * A name rather than a session id, because the org is not known until the workspace has been
 * resolved, and resolving it is the relay's own first step, off the socket.
 */
export const connectorRelayName = (event: InboundEvent): string =>
	event.type === "workspace-removed"
		? `${event.connector}:${event.workspaceId}`
		: `${event.connector}:${event.workspaceId}:${event.channelId}`

/**
 * The object that will handle a conversation's later messages.
 *
 * The same name the events themselves resolve to, built from where a reply goes rather than from
 * where the question was asked, which is the whole point: a conversation the bot OPENS is not the
 * one the message that opened it belongs to.
 */
export const connectorConversationRelayName = (
	connector: string,
	target: { readonly workspaceId: string; readonly channelId: string },
): string => `${connector}:${target.workspaceId}:${target.channelId}`

/**
 * The relay under one name, off the raw env, or `undefined` where the binding is missing.
 *
 * Only for a relay reaching another relay: a class cannot yield its own tag inside its activation
 * (its layer is the one being built), and alchemy's `DurableObjectScope` there is untyped, so the
 * namespace comes off env and is wrapped in alchemy's Effect RPC stub.
 */
export const connectorRelayByName = (
	env: Record<string, unknown>,
	name: string,
): ConnectorRelayRemote | undefined => {
	const namespace = env.ConnectorRelay
	if (!isRelayNamespace(namespace)) return undefined
	return Cloudflare.makeRpcStub<ConnectorRelayRemote>(namespace.get(namespace.idFromName(name)))
}
