// Non-formatting helpers for the session-replay surfaces, shared by the web app
// and the local-mode UI.

import { Option, Schema } from "effect"

const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString)

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
