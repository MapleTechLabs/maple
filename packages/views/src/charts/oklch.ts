import { String as Str } from "effect"

// OKLCH parsing and mixing for the colour ramps, with no d3: both the d3 sequential scale
// (./plot/color-scale.ts) and the view-side ramp (./sequential-colors.ts) interpolate through it.

export interface Oklch {
	readonly l: number
	readonly c: number
	readonly h: number
}

const OKLCH_RE = /^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([-\d.]+)/i

const parsePercentOrUnit = (raw: string, full: number): number =>
	Str.endsWith("%")(raw) ? (Number.parseFloat(raw) / 100) * full : Number.parseFloat(raw)

const srgbToLinear = (channel: number): number =>
	channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4

const parseHexToOklch = (color: string): Oklch | null => {
	if (!Str.startsWith("#")(color)) return null
	const body = Str.slice(1)(color)
	const expanded =
		body.length === 3
			? `${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`
			: Str.slice(0, 6)(body)
	if (expanded.length !== 6) return null
	const int = Number.parseInt(expanded, 16)
	if (!Number.isFinite(int)) return null

	const r = srgbToLinear(((int >> 16) & 0xff) / 255)
	const g = srgbToLinear(((int >> 8) & 0xff) / 255)
	const b = srgbToLinear((int & 0xff) / 255)

	// sRGB-linear → LMS → Oklab, the standard matrices from Björn Ottosson's
	// Oklab derivation. Only used for hex fallbacks; the real tokens are oklch().
	const lms0 = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
	const lms1 = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
	const lms2 = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)

	const l = 0.2104542553 * lms0 + 0.793617785 * lms1 - 0.0040720468 * lms2
	const a = 1.9779984951 * lms0 - 2.428592205 * lms1 + 0.4505937099 * lms2
	const bb = 0.0259040371 * lms0 + 0.7827717662 * lms1 - 0.808675766 * lms2

	return { l, c: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 }
}

/**
 * An `oklch()` literal (what `tokens.css` holds) or a hex fallback. Anything else returns `null`,
 * and callers keep the colour verbatim rather than emit a black `NaN` colour as d3-color would.
 */
export const parseOklch = (color: string): Oklch | null => {
	const [, lightness, chroma, hue] = OKLCH_RE.exec(Str.trim(color)) ?? []
	if (lightness === undefined || chroma === undefined || hue === undefined)
		return parseHexToOklch(Str.trim(color))
	const l = parsePercentOrUnit(lightness, 1)
	const c = parsePercentOrUnit(chroma, 0.4)
	const h = Number.parseFloat(hue)
	return Number.isFinite(l) && Number.isFinite(c) && Number.isFinite(h) ? { l, c, h } : null
}

const formatOklch = ({ l, c, h }: Oklch): string => `oklch(${l.toFixed(4)} ${c.toFixed(4)} ${h.toFixed(2)})`

/**
 * Numeric `color-mix(in oklch, low <1-t>, high <t>)`: L and C mix componentwise, H takes the
 * shorter arc. Emitted as an `oklch()` literal so canvas and the browser's CSS form agree.
 */
const mixOklch = (low: Oklch, high: Oklch, t: number): Oklch => {
	const raw = high.h - low.h
	const delta = raw > 180 ? raw - 360 : raw < -180 ? raw + 360 : raw
	return {
		l: low.l + (high.l - low.l) * t,
		c: low.c + (high.c - low.c) * t,
		h: (low.h + delta * t + 360) % 360,
	}
}

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0)

/** Parametric position 0..1 to a literal colour along the resolved stops (`parsed` is their `parseOklch`). */
export const rampColorAt = (
	t: number,
	stops: ReadonlyArray<string>,
	parsed: ReadonlyArray<Oklch | null>,
): string => {
	const clamped = clamp01(t)
	const segments = stops.length - 1
	if (segments <= 0) return stops[0] ?? "currentColor"
	const scaled = clamped * segments
	const lowIndex = Math.min(segments - 1, Math.floor(scaled))
	const highIndex = lowIndex + 1
	const local = scaled - lowIndex
	if (local <= 0) return stops[lowIndex] ?? "currentColor"
	if (local >= 1) return stops[highIndex] ?? "currentColor"

	const low = parsed[lowIndex]
	const high = parsed[highIndex]
	// Unparseable stop: snap to the nearer endpoint rather than emit NaN channels.
	if (!low || !high) return (local < 0.5 ? stops[lowIndex] : stops[highIndex]) ?? "currentColor"
	return formatOklch(mixOklch(low, high, local))
}

/**
 * A colour pushed `amount` (0 keeps it, 1 erases it) of the way toward the page background, for the
 * series a legend is not highlighting. A colour, not an opacity: one-mark charts (stacked bar,
 * treemap, pie) cannot vary opacity per datum. Both arguments must be resolved literals.
 */
export const muteColor = (color: string, background: string, amount: number): string => {
	const from = parseOklch(color)
	const to = parseOklch(background)
	if (!from || !to) return color
	return formatOklch(mixOklch(from, to, clamp01(amount)))
}
