// Everything that can start a moment after `init()` without losing data lives
// behind this chunk, so it stays off the eager bundle every page load pays for.
import type { ResolvedConfig } from "../config"
import { onDocumentPageload } from "../navigation"
import { recordDocumentTiming } from "./document-timing"
import { startLogs } from "./logs"

export function startDeferred(config: ResolvedConfig): () => Promise<void> {
	onDocumentPageload(recordDocumentTiming)
	const stops = [startLogs(config), async () => onDocumentPageload(undefined)]
	return async () => {
		await Promise.all(stops.map((stop) => stop()))
	}
}
