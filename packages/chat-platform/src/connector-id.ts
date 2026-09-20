import { Schema } from "effect"

/**
 * A connector's identity — and the only vendor-specific token allowed to cross
 * the boundary of `src/connectors/<id>/`.
 *
 * Lowercase alphanumerics, no separators: the id is a URL path segment
 * (`/connectors/<id>/webhook`), a Durable Object name and a span attribute, and
 * a separator-free alphabet keeps it unambiguous in all three — in particular it
 * cannot collide with the `-` the Durable Object naming and the worker names use
 * as a joiner.
 */
export const ChatConnectorId = Schema.String.check(Schema.isPattern(/^[a-z0-9]+$/)).pipe(
	Schema.brand("@maple/ChatConnectorId"),
	Schema.annotate({ identifier: "@maple/ChatConnectorId", title: "Chat Connector ID" }),
)
export type ChatConnectorId = Schema.Schema.Type<typeof ChatConnectorId>

/** For a connector declaring its own id at module scope; an invalid literal is a build-time bug. */
export const makeChatConnectorId = Schema.decodeUnknownSync(ChatConnectorId)
