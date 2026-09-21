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

/** The relay for this event, or `undefined` where the binding is missing. */
export const connectorRelayStub = (
	env: Record<string, unknown>,
	event: InboundEvent,
): ConnectorRelayStub | undefined => {
	const namespace = env.ConnectorRelay
	if (!isRelayNamespace(namespace)) return undefined
	return namespace.get(namespace.idFromName(connectorRelayName(event)))
}
