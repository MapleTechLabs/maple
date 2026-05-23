import type { ActionKind } from "./replay-player-context"

// Shared presentation helpers for the session-replay surfaces (list, detail,
// player, timeline). One home so the list and detail views can't drift.

/** `1m 23s` / `45s`, or `—` for missing/zero durations. */
export function formatDuration(ms: number | null): string {
	if (ms == null || ms <= 0) return "—"
	const totalSeconds = Math.round(ms / 1000)
	const minutes = Math.floor(totalSeconds / 60)
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
	try {
		const u = new URL(url)
		return `${u.host}${u.pathname === "/" ? "" : u.pathname}`
	} catch {
		return url
	}
}

const AVATAR_GRADIENTS = [
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
	return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length]!
}

/** Marker dot colour by action kind, shared by the player and timeline tracks. */
export const MARKER_STYLES: Record<ActionKind, string> = {
	click: "bg-amber-400",
	input: "bg-sky-400",
	scroll: "bg-violet-400",
	nav: "bg-emerald-400",
}
