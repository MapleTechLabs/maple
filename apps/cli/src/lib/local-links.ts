// Links into the UI `maple start` serves next to its API. The UI routes in the
// hash (`/#/traces/<id>`), and its logs page reads `range`, `service`,
// `severity` and `q` from the hash query.

import { timestampMs } from "./output"

/** The logs page's range picks, narrowest first (apps/local-ui/src/lib/time.ts). */
const UI_RANGES: ReadonlyArray<readonly [key: string, ms: number]> = [
	["1h", 3_600_000],
	["6h", 6 * 3_600_000],
	["24h", 24 * 3_600_000],
	["7d", 7 * 24 * 3_600_000],
	["30d", 30 * 24 * 3_600_000],
]

const uiBase = (baseUrl: string): string => `${baseUrl.replace(/\/+$/, "")}/#`

export const traceLink = (baseUrl: string, traceId: string): string =>
	`${uiBase(baseUrl)}/traces/${encodeURIComponent(traceId)}`

/**
 * The narrowest UI range that still reaches back to `startTime`. The UI's
 * windows end now, so an older `--start` widens it rather than missing rows.
 */
export const uiRangeFor = (startTime: string, nowMs: number = Date.now()): string => {
	const back = nowMs - timestampMs(startTime)
	// `startTime` is whole seconds, so `--since 1h` reaches back up to 1h + 999ms.
	const fit = UI_RANGES.find(([, ms]) => ms + 1_000 >= back)
	return Number.isFinite(back) && fit !== undefined ? fit[0] : "30d"
}

export const logsLink = (
	baseUrl: string,
	p: {
		readonly startTime: string
		readonly service?: string
		readonly severity?: string
		readonly search?: string
	},
	nowMs?: number,
): string => {
	const query = new URLSearchParams({ range: uiRangeFor(p.startTime, nowMs) })
	if (p.service !== undefined) query.set("service", p.service)
	if (p.severity !== undefined) query.set("severity", p.severity)
	if (p.search !== undefined) query.set("q", p.search)
	return `${uiBase(baseUrl)}/logs?${query.toString()}`
}

/** Each row gets a `url` to its trace. */
export const withTraceLinks = <A extends { readonly traceId: string }>(
	baseUrl: string,
	rows: ReadonlyArray<A>,
): ReadonlyArray<A & { readonly url: string }> =>
	rows.map((row) => ({ ...row, url: traceLink(baseUrl, row.traceId) }))

/** Logs with a trace get a `traceUrl`; logs carry no id the UI can open on its own. */
export const withLogTraceLinks = <A extends { readonly traceId: string }>(
	baseUrl: string,
	logs: ReadonlyArray<A>,
): ReadonlyArray<A & { readonly traceUrl?: string }> =>
	logs.map((log) => (log.traceId === "" ? log : { ...log, traceUrl: traceLink(baseUrl, log.traceId) }))
