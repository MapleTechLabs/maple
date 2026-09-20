/**
 * What a chat platform has to provide to carry a Maple agent turn.
 *
 * The whole package exists for one rule: everything that differs between one chat vendor and the
 * next lives under `src/connectors/<id>/`, behind this structure. Nothing above a connector
 * directory names a vendor — not an identifier, not a literal, not a test fixture — and adding a
 * platform is a directory beside the others plus one line in `src/connectors/index.ts`. The
 * isolation is checked, not trusted: `vendor-isolation.test.ts` reads the sources.
 */
import { Schema } from "effect"
import type { ChatOutbound } from "./outbound"

/**
 * A connector's identity, lowercase alphanumeric with no separators.
 *
 * It ends up in composite keys — an install row, an action token, a span attribute — so it must
 * never contain a character those use to join, which is why `-` is out rather than merely
 * discouraged.
 */
export const ChatConnectorId = Schema.String.pipe(
	Schema.check(Schema.isPattern(/^[a-z0-9]+$/)),
	Schema.brand("@maple/ChatConnectorId"),
)
export type ChatConnectorId = typeof ChatConnectorId.Type

/** Decode a connector's own id. A connector declares it at module scope, so a bad one fails the build. */
export const chatConnectorId = Schema.decodeUnknownSync(ChatConnectorId)

/**
 * One platform, as one structured export.
 *
 * `R` is what the connector's outbound needs from the host Worker — an HTTP client, its own
 * credential service. The host supplies those; the package never reads the environment.
 */
export interface ChatConnector<R = never> {
	readonly id: ChatConnectorId
	readonly outbound: ChatOutbound<R>
}
