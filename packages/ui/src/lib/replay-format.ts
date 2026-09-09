// Shared presentation helpers for the session-replay surfaces (list, detail,
// player, timeline) — used by both the web app and the local-mode UI so the
// two can't drift. Warehouse-coupled helpers (partition windows) stay in the
// web app: this package doesn't depend on @maple/query-engine.

import { Option, Schema } from "effect"
import { SESSION_LIVE_WINDOW_SECONDS } from "@maple/domain/query-engine"

const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString)

/** The two columns that together say what a session is doing. */
export interface SessionLiveness {
	/** `session_replays.Status` — `"active"` until an end row lands, if one ever does. */
	readonly status: string
	/** Heartbeat timestamp, or `null` when only the session-start row exists. */
	readonly lastActivityAt: string | null
	readonly startTime: string
	/** Stored wall-clock duration; `null` until the end row lands. */
	readonly durationMs?: number | null
}

const epochMs = (value: string | null): number | null => {
	if (value === null) return null
	const normalized = value.includes("T") ? value : value.replace(" ", "T")
	const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : `${normalized}Z`)
	return Number.isNaN(ms) ? null : ms
}

/**
 * Is this session happening right now?
 *
 * `status` alone is not an answer. The SDK writes `"ended"` from an unload
 * handler, which a killed tab, a crash, a slept phone or a browser that simply
 * never fires it will skip — so the row keeps saying `"active"` for the rest of
 * its 30-day retention. Measured against production that made the list's LIVE
 * pill wrong on 69 of the 70 sessions wearing it. Recency is the other half:
 * the tab heartbeats `LastActivityAt` every 60s while visible, so silence past
 * the shared live window means nobody is there.
 *
 * The same window backs the analytics live badge, which is the point — the two
 * pages link to each other and used to disagree by two orders of magnitude.
 */
export function isSessionLive(session: SessionLiveness, nowMs: number): boolean {
	if (session.status !== "active") return false
	// A session with no heartbeat yet is judged on its start: it is either
	// seconds old and genuinely live, or it is the stranded v1 row of a tab that
	// went away, and the window separates those without a special case.
	const last = epochMs(session.lastActivityAt) ?? epochMs(session.startTime)
	if (last === null) return false
	return nowMs - last <= SESSION_LIVE_WINDOW_SECONDS * 1000
}

/**
 * The session's length, in ms, or `null` when nothing measures it.
 *
 * `DurationMs` is written on the end row only, so every session that never sent
 * one reads as unmeasured forever — a fifth of all sessions, rendered as a dash
 * next to a pulsing LIVE pill. The heartbeat is what recovers them: the span
 * from start to last-seen is how long the person was actually there, whether
 * they are still there or their tab died an hour ago.
 */
export function sessionDurationMs(session: SessionLiveness): number | null {
	if (session.durationMs != null && session.durationMs > 0) return session.durationMs
	const start = epochMs(session.startTime)
	const last = epochMs(session.lastActivityAt)
	if (start === null || last === null) return null
	return Math.max(0, last - start)
}

/**
 * `6h 12m` / `1m 23s` / `45s`, or `—` for missing/zero durations — a replay
 * with no measurable duration is unmeasured, not instantaneous.
 *
 * Named for the session it measures rather than `formatDuration`: this renders a
 * wall-clock span in clock units, which is a different job from the μs→h ladder
 * in `./format`. Sharing the name meant the two got imported interchangeably.
 *
 * Minutes roll over at an hour: agent sessions that wait on a human run for
 * hours, and "360m 0s" is not a duration anyone reads as six.
 */

export function formatSessionDuration(ms: number | null): string {
	if (ms == null || ms <= 0) return "—"
	const totalSeconds = Math.round(ms / 1000)
	const minutes = Math.floor(totalSeconds / 60)
	if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
	const seconds = totalSeconds % 60
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/** Playhead clock `m:ss`. Clamps non-finite/negative input to 0. */
export function formatClock(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) ms = 0
	const totalSeconds = Math.floor(ms / 1000)
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = totalSeconds % 60
	return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

/** Host + path for compact URL display; returns the raw input if unparseable. */
export function hostFromUrl(url: string): string {
	const parsed = decodeUrl(url)
	if (Option.isNone(parsed)) return url
	const { host, pathname } = parsed.value
	return `${host}${pathname === "/" ? "" : pathname}`
}

const AVATAR_GRADIENTS: readonly [string, ...string[]] = [
	"from-rose-500/80 to-orange-400/80",
	"from-violet-500/80 to-fuchsia-400/80",
	"from-sky-500/80 to-cyan-400/80",
	"from-emerald-500/80 to-teal-400/80",
	"from-amber-500/80 to-yellow-400/80",
	"from-indigo-500/80 to-blue-400/80",
]

/** Deterministic avatar gradient for a session, keyed by a stable seed. */
export function gradientFor(seed: string): string {
	let hash = 0
	for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
	return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length] ?? AVATAR_GRADIENTS[0]
}

/** `true` for handheld device-type strings as reported by the browser SDK. */
export function isMobileDevice(deviceType: string): boolean {
	const d = deviceType.toLowerCase()
	return d === "mobile" || d === "tablet" || d === "phone"
}

// Relative-time formatting lives in `./time-format` — import `formatRelativeFrom`
// for an epoch-ms instant. The `Intl.RelativeTimeFormat` version that used to
// live here rendered "2 hours ago" while the rest of the app rendered "2h ago".
