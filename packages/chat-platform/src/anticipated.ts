import { chatConnectorManifests } from "./connectors/manifests"

/**
 * Connector retry signals that are expected, not failures: a 429 the retry loop waits out. The
 * attempt span keeps its 429 status but records no exception event; giving up still fails with a
 * `ChatOutboundError`. Each connector's internal tag is `@maple/chat-platform/connectors/<id>/RateLimited`.
 */
export const CHAT_ANTICIPATED_ERROR_IDENTIFIERS: ReadonlyArray<string> = chatConnectorManifests.map(
	(manifest) => `@maple/chat-platform/connectors/${manifest.id}/RateLimited`,
)
