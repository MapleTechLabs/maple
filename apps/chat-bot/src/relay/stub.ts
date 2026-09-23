// BOUNDARY: this module reads a Durable Object namespace off a Worker env, a value nothing has parsed.
/**
 * Reaching a conversation's relay object from the socket that received the event.
 *
 * Deliberately tiny and free of the relay itself: this is imported by the ingress path, which runs
 * on every frame, while everything the relay does is behind the object's own dynamic import.
 */
import type { InboundEvent } from "@maple/chat-platform"

export interface ConnectorRelayStub {
	readonly deliver: (event: InboundEvent) => Promise<void>
	/**
	 * Record that the bot opened this conversation, on the object that will handle its later
	 * messages — which is not the one handling the message that opened it.
	 */
	readonly remember: (conversationKey: string) => Promise<void>
}

interface ConnectorRelayNamespace {
	readonly idFromName: (name: string) => unknown
	readonly get: (id: unknown) => ConnectorRelayStub
}

const isRelayNamespace = (value: unknown): value is ConnectorRelayNamespace =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { get?: unknown }).get === "function" &&
	typeof (value as { idFromName?: unknown }).idFromName === "function"

/**
 * Which object handles an event: one per conversation, or one per workspace for an event that has
 * no conversation.
 *
 * A name rather than a session id, because the org is not known until the workspace has been
 * resolved — and resolving it is the relay's own first step, off the socket.
 */
const connectorRelayName = (event: InboundEvent): string =>
	event.type === "workspace-removed"
		? `${event.connector}:${event.workspaceId}`
		: `${event.connector}:${event.workspaceId}:${event.channelId}`

/**
 * The object that will handle a conversation's later messages.
 *
 * The same name the events themselves resolve to, built from where a reply goes rather than from
 * where the question was asked — which is the whole point: a conversation the bot OPENS is not the
 * one the message that opened it belongs to.
 */
export const connectorConversationRelayName = (
	connector: string,
	target: { readonly workspaceId: string; readonly channelId: string },
): string => `${connector}:${target.workspaceId}:${target.channelId}`

/** The relay under one name, or `undefined` where the binding is missing. */
export const connectorRelayByName = (
	env: Record<string, unknown>,
	name: string,
): ConnectorRelayStub | undefined => {
	const namespace = env.ConnectorRelay
	if (!isRelayNamespace(namespace)) return undefined
	return namespace.get(namespace.idFromName(name))
}

/** The relay for this event, or `undefined` where the binding is missing. */
export const connectorRelayStub = (
	env: Record<string, unknown>,
	event: InboundEvent,
): ConnectorRelayStub | undefined => connectorRelayByName(env, connectorRelayName(event))
