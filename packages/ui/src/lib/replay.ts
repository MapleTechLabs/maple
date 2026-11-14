// Non-formatting helpers for the session-replay surfaces, shared by the web app
// and the local-mode UI.

import { Option, Schema, String as Str } from "effect"
import { codeUnitAt } from "@maple/strings"

const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString)

/** Host + path for compact URL display; returns the raw input if unparseable. */
export function hostFromUrl(url: string): string {
	const parsed = decodeUrl(url)
	if (Option.isNone(parsed)) return url
	const { host, pathname } = parsed.value
	return `${host}${pathname === "/" ? "" : pathname}`
}

// Pairs of neighbouring service hues: rose to orange, violet to magenta, blue to cyan, green to
// teal, amber to yellow, indigo to blue.
const AVATAR_GRADIENTS: readonly [string, ...string[]] = [
	"from-service-9 to-service-7",
	"from-service-13 to-service-11",
	"from-service-1 to-service-15",
	"from-service-3 to-service-2",
	"from-service-6 to-service-5",
	"from-service-14 to-service-1",
]

/** Deterministic avatar gradient for a session, keyed by a stable seed. */
export function gradientFor(seed: string): string {
	let hash = 0
	for (let i = 0; i < seed.length; i++) hash = (hash * 31 + codeUnitAt(seed, i)) >>> 0
	return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length] ?? AVATAR_GRADIENTS[0]
}

/** `true` for handheld device-type strings as reported by the browser SDK. */
export function isMobileDevice(deviceType: string): boolean {
	const d = Str.toLowerCase(deviceType)
	return d === "mobile" || d === "tablet" || d === "phone"
}
