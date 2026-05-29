// Time-range resolution shared by the CLI and the HTTP server. Plain (non-Effect)
// so the Bun.serve fetch handler can call it directly. Emits ClickHouse-style
// `YYYY-MM-DD HH:mm:ss` UTC strings, matching what the query engine expects.

export interface Range {
	readonly startTime: string
	readonly endTime: string
}

const pad = (n: number): string => String(n).padStart(2, "0")

const formatDateTimeUTC = (d: Date): string =>
	`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
	`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`

const SINCE_RE = /^(\d+)(m|h|d)$/

/** Parse a relative window like `30m`, `6h`, `7d` to milliseconds (default 6h). */
const parseSinceMs = (since: string): number => {
	const match = since.match(SINCE_RE)
	if (!match) return 6 * 60 * 60 * 1000
	const n = Number(match[1])
	switch (match[2]) {
		case "m":
			return n * 60 * 1000
		case "d":
			return n * 24 * 60 * 60 * 1000
		default:
			return n * 60 * 60 * 1000
	}
}

export const resolveRange = (opts: {
	since?: string
	start?: string
	end?: string
}): Range => {
	if (opts.start && opts.end) {
		return { startTime: opts.start, endTime: opts.end }
	}
	const now = new Date()
	const endTime = opts.end ?? formatDateTimeUTC(now)
	const startTime =
		opts.start ?? formatDateTimeUTC(new Date(now.getTime() - parseSinceMs(opts.since ?? "6h")))
	return { startTime, endTime }
}
