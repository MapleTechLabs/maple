// Everything that can start a moment after `init()` without losing data lives
// behind this chunk, so it stays off the eager bundle every page load pays for.
import type { ResolvedConfig } from "../config"
import { startLogs } from "./logs"

export function startDeferred(config: ResolvedConfig): () => Promise<void> {
	const stops = [startLogs(config)]
	return async () => {
		await Promise.all(stops.map((stop) => stop()))
	}
}
