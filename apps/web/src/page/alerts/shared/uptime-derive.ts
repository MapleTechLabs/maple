import type { V2UptimeMonitor } from "@maple/domain/http/v2"
import type { Tone } from "@maple/ui/lib/tone"
import { isoMs } from "./time"

// Pure reads of an uptime monitor shared by the Uptime tab, the monitor page and the service card.

export type UptimeMonitor = V2UptimeMonitor
export type RecentCheck = UptimeMonitor["state"]["recent"][number]

/** The status a reader sees: `degraded` is not down yet but its latest checks failed. */
export type DisplayStatus = "up" | "down" | "degraded" | "pending" | "paused"

export const displayStatus = (monitor: UptimeMonitor): DisplayStatus => {
	const { status, consecutive_failures: failures } = monitor.state
	if (status === "paused" || !monitor.enabled) return "paused"
	if (status === "down") return "down"
	if (failures > 0) return "degraded"
	return status === "pending" ? "pending" : "up"
}

export const STATUS_TONE = {
	up: "ok",
	down: "crit",
	degraded: "warn",
	pending: "neutral",
	paused: "neutral",
} as const satisfies Record<DisplayStatus, Tone>

/** `6m`, `3h 12m`, `2d 4h`: the two largest units of a span. */
export const formatSpan = (ms: number): string => {
	const seconds = Math.max(0, Math.floor(ms / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
	const days = Math.floor(hours / 24)
	return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`
}

/** A cadence in seconds as `30s`, `5m`, `24h`. */
export const formatEvery = (seconds: number): string => formatSpan(seconds * 1000)

const sinceChange = (monitor: UptimeMonitor, nowMs: number): string | null => {
	const changed = monitor.state.status_changed_at
	return changed === null ? null : formatSpan(nowMs - isoMs(changed))
}

/** The chip text, sentence case: "Down 6m", "Degraded", "Paused". */
export const statusLabel = (monitor: UptimeMonitor, nowMs: number): string => {
	const status = displayStatus(monitor)
	switch (status) {
		case "down": {
			const since = sinceChange(monitor, nowMs)
			return since === null ? "Down" : `Down ${since}`
		}
		case "degraded":
			return "Degraded"
		case "pending":
			return "Pending"
		case "paused":
			return "Paused"
		case "up":
			return "Up"
	}
}

export const KIND_LABEL = {
	http: "HTTP",
	tcp: "TCP",
	dns: "DNS",
	heartbeat: "Heartbeat",
} as const satisfies Record<UptimeMonitor["kind"], string>

/** A URL without its scheme, as the list shows it. */
export const bareUrl = (url: string): string => url.replace(/^https?:\/\//u, "")

export const heartbeatScheduleLabel = (
	config: Extract<UptimeMonitor["config"], { type: "heartbeat" }>,
): string =>
	config.schedule.type === "interval"
		? `Every ${formatEvery(config.schedule.seconds)}`
		: `Cron ${config.schedule.expression} (${config.schedule.timezone})`

/** The second line of a monitor: what it checks. */
export const targetLine = (monitor: UptimeMonitor, nowMs: number): string => {
	const config = monitor.config
	switch (config.type) {
		case "http":
			return bareUrl(config.url)
		case "tcp":
			return `${config.host}:${config.port}`
		case "dns":
			return `${config.record_type} ${config.hostname}${config.expected === undefined ? "" : ` = ${config.expected}`}`
		case "heartbeat": {
			const ping = monitor.state.last_ping_at
			const pinged = ping === null ? "no ping yet" : `last ping ${formatSpan(nowMs - isoMs(ping))} ago`
			return `${heartbeatScheduleLabel(config)}, ${formatEvery(config.grace_seconds)} grace · ${pinged}`
		}
	}
}

/** The detail page's request line: `GET https://…`, `host:port`, `MX example.com`. */
export const requestLine = (monitor: UptimeMonitor): string => {
	const config = monitor.config
	switch (config.type) {
		case "http":
			return `${config.method ?? "GET"} ${config.url}`
		case "tcp":
			return `${config.host}:${config.port}`
		case "dns":
			return `${config.record_type} ${config.hostname}`
		case "heartbeat":
			return `${heartbeatScheduleLabel(config)}, ${formatEvery(config.grace_seconds)} grace`
	}
}

/** Share of passing checks, or `null` with none. */
export const uptimeShare = (recent: ReadonlyArray<RecentCheck>): number | null =>
	recent.length === 0 ? null : recent.filter((check) => check.ok).length / recent.length

/** `99.58%`; whole shares drop the decimals. */
export const formatShare = (share: number | null): string => {
	if (share === null) return "–"
	// Rounded first: 11/20 * 100 is 55.00000000000001, which must still read "55%".
	const percent = Math.round(share * 10_000) / 100
	return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(2)}%`
}

export type LatencyPercentiles = Readonly<{ p50: number | null; p95: number | null; p99: number | null }>

/** Nearest-rank p50, p95 and p99 of the recent durations, each `null` with none. */
export const latencyPercentiles = (recent: ReadonlyArray<RecentCheck>): LatencyPercentiles => {
	const sorted = recent
		.flatMap((check) => (check.duration_ms === null ? [] : [check.duration_ms]))
		.sort((a, b) => a - b)
	const at = (q: number) =>
		sorted.length === 0
			? null
			: (sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] ?? null)
	return { p50: at(0.5), p95: at(0.95), p99: at(0.99) }
}

export const formatMs = (ms: number | null): string =>
	ms === null ? "–" : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`

/** The status segments of the Uptime tab. */
export type StatusFilter = "all" | "down" | "degraded" | "paused"

export const matchesStatus = (monitor: UptimeMonitor, filter: StatusFilter): boolean =>
	filter === "all" || displayStatus(monitor) === filter

/** Name or target contains the query, case-insensitively. */
export const matchesQuery = (monitor: UptimeMonitor, query: string, nowMs: number): boolean => {
	const needle = query.trim().toLowerCase()
	return (
		needle === "" ||
		monitor.name.toLowerCase().includes(needle) ||
		targetLine(monitor, nowMs).toLowerCase().includes(needle)
	)
}

export type UptimeSummary = Readonly<{
	total: number
	up: number
	down: number
	degraded: number
	paused: number
	share: number | null
}>

export const summarize = (monitors: ReadonlyArray<UptimeMonitor>): UptimeSummary => {
	const count = (status: DisplayStatus) =>
		monitors.filter((monitor) => displayStatus(monitor) === status).length
	const active = monitors.filter((monitor) => displayStatus(monitor) !== "paused")
	return {
		total: monitors.length,
		up: count("up"),
		down: count("down"),
		degraded: count("degraded"),
		paused: count("paused"),
		share: uptimeShare(active.flatMap((monitor) => monitor.state.recent)),
	}
}
