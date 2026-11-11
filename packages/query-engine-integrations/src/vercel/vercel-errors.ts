// A Vercel project's error logs, clustered into message templates. Vercel's lines carry request
// ids, tool call ids and timings, so grouping by the raw message makes one row per line.

import { Array as Arr, Order, String as Str } from "effect"
import { makeLogTemplateMiner } from "@maple/query-engine/observability"

/** One line from `vercelProjectErrorLogsSQL`, newest first. */
export interface VercelErrorLogRow {
	readonly timestamp: string
	readonly body: string
	readonly source: string
	readonly traceId: string
	readonly spanId: string
}

export interface VercelErrorPattern {
	/** The message with its variable parts as `<*>` (or `<uuid>`, `<ip>`...). */
	readonly pattern: string
	/** The newest line in the pattern, in full. */
	readonly sample: string
	readonly occurrences: number
	/** `lambda`, `edge`, `build`... of the newest line. */
	readonly source: string
	/** The newest line's timestamp, as the warehouse returned it. */
	readonly lastSeen: string
	/** The newest line's trace, when it carried one. */
	readonly traceId: string | null
	readonly spanId: string | null
}

interface Cluster {
	readonly first: VercelErrorLogRow
	template: string
	occurrences: number
}

const ALL_ZERO = /^0*$/

const idOrNull = (id: string): string | null => (ALL_ZERO.test(id) ? null : id)

const byOccurrences = Order.mapInput(Order.flip(Order.Number), (p: VercelErrorPattern) => p.occurrences)

/**
 * The rows' message templates, most frequent first. Rows arrive newest first, so a cluster's
 * first row is its newest line: its sample, last seen and trace.
 */
export const clusterVercelErrorLogs = (
	rows: ReadonlyArray<VercelErrorLogRow>,
	limit = 20,
): ReadonlyArray<VercelErrorPattern> => {
	const miner = makeLogTemplateMiner()
	const clusters = new Map<number, Cluster>()
	for (const row of rows) {
		const body = Str.trim(row.body)
		if (body.length === 0) continue
		const mined = miner.addLogMessage(body)
		const cluster = clusters.get(mined.clusterId)
		if (cluster === undefined) {
			clusters.set(mined.clusterId, { first: row, template: mined.templateMined, occurrences: 1 })
		} else {
			cluster.template = mined.templateMined
			cluster.occurrences += 1
		}
	}
	const patterns = Arr.map(
		Array.from(clusters.values()),
		(cluster): VercelErrorPattern => ({
			pattern: cluster.template,
			sample: Str.trim(cluster.first.body),
			occurrences: cluster.occurrences,
			source: cluster.first.source,
			lastSeen: cluster.first.timestamp,
			traceId: idOrNull(cluster.first.traceId),
			spanId: idOrNull(cluster.first.spanId),
		}),
	)
	return Arr.take(Arr.sort(patterns, byOccurrences), limit)
}

const PLACEHOLDER = /<[a-z*]+>/g

/**
 * The longest literal run of a pattern, for the logs explorer's body search: the part every line
 * in the pattern shares. Null when no run is long enough to narrow the search.
 */
export const errorPatternSearch = (pattern: string): string | null => {
	const runs = Arr.map(Str.split(pattern, PLACEHOLDER), Str.trim)
	const longest = Arr.reduce(runs, "", (best, run) => (run.length > best.length ? run : best))
	return longest.length >= 6 ? Str.slice(0, 120)(longest) : null
}
