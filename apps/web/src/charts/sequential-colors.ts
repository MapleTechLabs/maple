import { resolveSequentialDomain, type SequentialScaleType } from "./sequential-domain"

// `createSequentialColorScale` (packages/ui/src/components/plot/color-scale.ts) without d3: the
// view needs the ramp's colours for legends, and d3-scale stays behind the chart Mount (S2).
// The OKLCH parsing and mixing are copied verbatim; d3's clamped sequential map is restated.

interface Oklch {
	readonly l: number
	readonly c: number
	readonly h: number
}

const OKLCH_RE = /^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([-\d.]+)/i

const parsePercentOrUnit = (raw: string, full: number): number =>
	raw.endsWith("%") ? (Number.parseFloat(raw) / 100) * full : Number.parseFloat(raw)

const srgbToLinear = (channel: number): number =>
	channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4

const parseHexToOklch = (color: string): Oklch | null => {
	if (!color.startsWith("#")) return null
	const body = color.slice(1)
	const expanded =
		body.length === 3 ? `${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}` : body.slice(0, 6)
	if (expanded.length !== 6) return null
	const int = Number.parseInt(expanded, 16)
	if (!Number.isFinite(int)) return null
	const r = srgbToLinear(((int >> 16) & 0xff) / 255)
	const g = srgbToLinear(((int >> 8) & 0xff) / 255)
	const b = srgbToLinear((int & 0xff) / 255)
	const lms0 = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
	const lms1 = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
	const lms2 = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
	const l = 0.2104542553 * lms0 + 0.793617785 * lms1 - 0.0040720468 * lms2
	const a = 1.9779984951 * lms0 - 2.428592205 * lms1 + 0.4505937099 * lms2
	const bb = 0.0259040371 * lms0 + 0.7827717662 * lms1 - 0.808675766 * lms2
	return { l, c: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 }
}

const parseOklch = (color: string): Oklch | null => {
	const oklch = OKLCH_RE.exec(color.trim())
	if (oklch === null) return parseHexToOklch(color.trim())
	const l = parsePercentOrUnit(oklch[1] ?? "", 1)
	const c = parsePercentOrUnit(oklch[2] ?? "", 0.4)
	const h = Number.parseFloat(oklch[3] ?? "")
	return Number.isFinite(l) && Number.isFinite(c) && Number.isFinite(h) ? { l, c, h } : null
}

const formatOklch = ({ l, c, h }: Oklch): string => `oklch(${l.toFixed(4)} ${c.toFixed(4)} ${h.toFixed(2)})`

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

const colorAt = (t: number, stops: ReadonlyArray<string>, parsed: ReadonlyArray<Oklch | null>): string => {
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
	if (low === null || low === undefined || high === null || high === undefined)
		return (local < 0.5 ? stops[lowIndex] : stops[highIndex]) ?? "currentColor"
	return formatOklch(mixOklch(low, high, local))
}

/** `scaleSequential(…).clamp(true)` / `scaleSequentialLog(…).clamp(true)` as a plain function. */
export const sequentialColorScale = (options: {
	readonly stops: ReadonlyArray<string>
	readonly domain: readonly [number, number]
	readonly scaleType: SequentialScaleType
}): ((value: number) => string) => {
	const parsed = options.stops.map(parseOklch)
	const [lo, hi] = resolveSequentialDomain(options.domain, options.scaleType)
	const transform = options.scaleType === "log" ? Math.log : (value: number) => value
	const t0 = transform(lo)
	const t1 = transform(hi)
	const k = t0 === t1 ? 0 : 1 / (t1 - t0)
	return (value) => {
		const raw = k === 0 ? 0.5 : (transform(value) - t0) * k
		return colorAt(Math.max(0, Math.min(1, raw)), options.stops, parsed)
	}
}

/** `muteColor` (color-scale.ts): a colour pushed `amount` of the way toward the background. */
export const muteColor = (color: string, background: string, amount: number): string => {
	const from = parseOklch(color)
	const to = parseOklch(background)
	if (!from || !to) return color
	return formatOklch(mixOklch(from, to, Math.max(0, Math.min(1, amount))))
}
