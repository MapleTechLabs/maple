/**
 * Chart color Tailwind classes for depth-based coloring in visualizations.
 * Maps to Tailwind classes: bg-chart-1 through bg-chart-5
 */
export const CHART_BG_CLASSES = [
	"bg-chart-1",
	"bg-chart-2",
	"bg-chart-3",
	"bg-chart-4",
	"bg-chart-5",
] as const

/**
 * Get a chart background color class based on depth level.
 * Cycles through chart-1 to chart-5 based on depth % 5.
 */
export function getDepthColorClass(depth: number): string {
	return CHART_BG_CLASSES[depth % CHART_BG_CLASSES.length]
}

/**
 * Simple hash function for strings
 */
function hashString(str: string): number {
	let hash = 0
	for (let i = 0; i < str.length; i++) {
		hash = str.charCodeAt(i) + ((hash << 5) - hash)
	}
	return Math.abs(hash)
}

/**
 * Base hues for services - warm to cool spectrum
 * Using OKLCH for perceptually uniform colors
 */
const SERVICE_HUES = [
	250, // Blue
	185, // Teal
	155, // Green
	130, // Lime
	90, // Yellow
	60, // Amber
	45, // Orange
	25, // Red
	0, // Rose
	340, // Pink
	320, // Magenta
	290, // Purple
	270, // Violet
	260, // Indigo
	210, // Cyan
	230, // Slate
]

/**
 * Extract class name from span name pattern "Class.FunctionName" or "Class::FunctionName"
 */
export function extractClassName(spanName: string): string | null {
	// Match patterns like "Class.Method", "Namespace.Class.Method", "Class::Method"
	const dotMatch = spanName.match(/^(.+?)\.[\w]+$/)
	if (dotMatch) {
		return dotMatch[1]
	}
	const colonMatch = spanName.match(/^(.+?)::[\w]+$/)
	if (colonMatch) {
		return colonMatch[1]
	}
	return null
}

/**
 * Get the hue for a service, derived purely from a hash of its name so a
 * service keeps the same hue everywhere in the product (lists, timelines,
 * service map) regardless of which other services are on screen.
 */
export function getServiceHueFromName(serviceName: string): number {
	return SERVICE_HUES[hashString(serviceName) % SERVICE_HUES.length]
}

/**
 * Lightness/chroma tiers layered on top of the 16 hues. A second hash
 * dimension picks the tier, tripling the palette to 48 slots so services
 * that land on neighboring hues (teal/cyan, blue/violet, …) still separate
 * by depth. All tiers stay mid-lightness so they read on both themes: below ~0.55 a hue
 * turns muddy on the dark canvas, and chroma under ~0.13 reads washed out.
 */
const SERVICE_COLOR_TIERS = [
	{ l: 0.57, c: 0.17 },
	{ l: 0.65, c: 0.16 },
	{ l: 0.73, c: 0.14 },
]

/** Yellow through lime go olive at mid lightness, so they sit one step lighter. */
const tierLightness = (l: number, hue: number): number => (hue >= 70 && hue <= 140 ? l + 0.08 : l)

function getServiceColorTier(serviceName: string): { l: number; c: number } {
	const hash = hashString(serviceName)
	return SERVICE_COLOR_TIERS[Math.floor(hash / SERVICE_HUES.length) % SERVICE_COLOR_TIERS.length]
}

/**
 * The identity palette flattened to a single index space: `tier * 16 + hue`.
 * Chart series resolution needs slot-addressable access so it can detect (and
 * deterministically step past) two names that hash to the same color.
 */
export const IDENTITY_SLOT_COUNT = SERVICE_HUES.length * SERVICE_COLOR_TIERS.length

/** The slot a name naturally hashes to — the same hue/tier pair as {@link getServiceColor}. */
export function getIdentitySlot(name: string): number {
	const hash = hashString(name)
	const hueIndex = hash % SERVICE_HUES.length
	const tierIndex = Math.floor(hash / SERVICE_HUES.length) % SERVICE_COLOR_TIERS.length
	return tierIndex * SERVICE_HUES.length + hueIndex
}

/** The color occupying a given identity slot. Wraps, so any integer is valid. */
export function getIdentityColorBySlot(slot: number): string {
	const index = ((Math.floor(slot) % IDENTITY_SLOT_COUNT) + IDENTITY_SLOT_COUNT) % IDENTITY_SLOT_COUNT
	const tier = SERVICE_COLOR_TIERS[Math.floor(index / SERVICE_HUES.length)]
	const hue = SERVICE_HUES[index % SERVICE_HUES.length]
	return `oklch(${tierLightness(tier.l, hue).toFixed(2)} ${tier.c} ${hue})`
}

/**
 * The canonical color for a service, deterministic from its name alone.
 * Hue and lightness tier both derive from the name hash.
 */
export function getServiceColor(serviceName: string): string {
	return getIdentityColorBySlot(getIdentitySlot(serviceName))
}

/**
 * Get a color style for a span based on its service and class name.
 * - Each service gets a distinct base hue
 * - Each class within a service gets a lightness/saturation variation
 * - Returns inline style object with background color and appropriate text color
 */
export function getSpanColorStyle(
	spanName: string,
	serviceName: string,
): { readonly backgroundColor: string; readonly color: string } {
	const baseHue = getServiceHueFromName(serviceName)

	const className = extractClassName(spanName)

	let lightness = 0.55
	let chroma = 0.15

	if (className) {
		const classHash = hashString(className)
		lightness = 0.45 + (classHash % 20) / 100
		chroma = 0.12 + (classHash % 6) / 100
	}

	const bgColor = `oklch(${lightness} ${chroma} ${baseHue})`

	const textColor = lightness > 0.55 ? "oklch(0.2 0 0)" : "oklch(0.98 0 0)"

	return {
		backgroundColor: bgColor,
		color: textColor,
	}
}

/**
 * Get a border accent color for a service (slightly darker/more saturated than background)
 */
export function getServiceBorderColor(serviceName: string): string {
	const tier = getServiceColorTier(serviceName)
	return `oklch(${tier.l - 0.08} ${tier.c + 0.02} ${getServiceHueFromName(serviceName)})`
}

/**
 * Resolve a hue for a string value, used to color trace timeline bars by
 * an arbitrary attribute. Returns null for empty/missing values so callers
 * can render a neutral fallback. Shares hues with getServiceColor.
 */
export function getValueHue(value: string | undefined | null): number | null {
	if (value == null || value === "") return null
	return SERVICE_HUES[hashString(value) % SERVICE_HUES.length]
}

/**
 * Calculate self-time for a span (duration minus overlapping children time)
 */
export function calculateSelfTime(
	span: { startTime: string; durationMs: number; clockSkewMs?: number },
	children: Array<{ startTime: string; durationMs: number; clockSkewMs?: number }>,
): number {
	if (children.length === 0) return span.durationMs

	const spanStartMs = new Date(span.startTime).getTime() + (span.clockSkewMs ?? 0)
	const spanEndMs = spanStartMs + span.durationMs

	// Calculate total time covered by children (accounting for overlaps)
	const childIntervals = children
		.map((child) => {
			const childStartMs = new Date(child.startTime).getTime() + (child.clockSkewMs ?? 0)
			const childEndMs = childStartMs + child.durationMs
			// Clamp to parent span boundaries
			return {
				start: Math.max(childStartMs, spanStartMs),
				end: Math.min(childEndMs, spanEndMs),
			}
		})
		.filter((i) => i.end > i.start)

	if (childIntervals.length === 0) return span.durationMs

	// Merge overlapping intervals
	childIntervals.sort((a, b) => a.start - b.start)
	const merged: Array<{ start: number; end: number }> = []

	for (const interval of childIntervals) {
		if (merged.length === 0 || merged[merged.length - 1].end < interval.start) {
			merged.push({ ...interval })
		} else {
			merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, interval.end)
		}
	}

	const childrenTime = merged.reduce((sum, i) => sum + (i.end - i.start), 0)
	return Math.max(0, span.durationMs - childrenTime)
}

/** Last-resort colour for a token that is neither on the document nor in {@link TOKEN_FALLBACK}. */
export const DEFAULT_TOKEN_FALLBACK = "#e8872a"

/**
 * The one hex fallback per design token, used where a token cannot be read off
 * the document (SSR, tests, a canvas painted before styles load), from the dark theme. Callers name
 * the token only; nothing else should carry its own `["--token", "#hex"]` pair.
 */
export const TOKEN_FALLBACK: Readonly<Record<string, string>> = {
	"--background": "#1a1714",
	"--foreground": "#e8e0d6",
	"--border": "#2a2520",
	"--muted-foreground": "#9b9084",
	"--primary": "#e8872a",
	"--destructive": "#e85d4b",
	"--chart-1": "#e8872a",
	"--chart-2": "#4a9eff",
	"--chart-3": "#49a866",
	"--chart-4": "#00aa9a",
	"--chart-5": "#b589d6",
	"--chart-p99": "#e85d4b",
	"--chart-p95": "#e8872a",
	"--chart-p50": "#4a9eff",
	"--chart-error": "#ef2e43",
	"--chart-throughput": "#9281e1",
	"--chart-apdex": "#49a866",
	"--severity-trace": "#8a7f72",
	"--severity-debug": "#4a9eff",
	"--severity-info": "#49a866",
	"--severity-warn": "#ebb432",
	"--severity-error": "#e85d4b",
	"--severity-fatal": "#c43d2e",
	"--info": "#4a9eff",
	"--success": "#49a866",
	"--warning": "#ebb432",
} satisfies Record<string, string>

/**
 * The hex fallback for `--token`, `var(--token)` or Tailwind's `--color-token` alias;
 * {@link DEFAULT_TOKEN_FALLBACK} when unmapped.
 */
export function tokenFallback(token: string): string {
	const inner = token.startsWith("var(") && token.endsWith(")") ? token.slice(4, -1).trim() : token
	const name = inner.startsWith("--color-") ? `--${inner.slice("--color-".length)}` : inner
	return Object.hasOwn(TOKEN_FALLBACK, name) ? TOKEN_FALLBACK[name] : DEFAULT_TOKEN_FALLBACK
}
