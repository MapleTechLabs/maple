// The colour tokens the prototypes read, kept apart from their definitions so the lab page can
// resolve them without loading `@tanstack/charts`.

export const LINE_TOKENS = ["--chart-p99", "--chart-p95", "--chart-p50"] as const
export const AREA_TOKENS = ["--chart-throughput", "--chart-error"] as const
export const CHROME_TOKENS = ["--border", "--background"] as const

/** `STACK_TOKENS` (stacked-bar-spike.tsx): one chart token per service. */
export const STACK_TOKEN_BY_SERVICE: ReadonlyMap<string, string> = new Map([
	["api", "--chart-1"],
	["web", "--chart-2"],
	["ingest", "--chart-3"],
	["worker", "--chart-4"],
	["db", "--chart-5"],
])
export const STACK_TOKENS = [...STACK_TOKEN_BY_SERVICE.values(), "--foreground", "--background"]

/** A token with the literal `resolvePlotColor` falls back to when the property is unset. */
export type TokenWithFallback = readonly [token: string, fallback: string]

/** `HEATMAP_RAMP_TOKENS` and `DENSITY_RAMP_TOKENS` (packages/ui/src/components/plot/color-scale.ts). */
export const RAMP_TOKENS = {
	amber: [
		["--heatmap-amber-0", "oklch(0.32 0.035 70)"],
		["--heatmap-amber-1", "oklch(0.45 0.075 65)"],
		["--heatmap-amber-2", "oklch(0.58 0.115 60)"],
		["--heatmap-amber-3", "oklch(0.71 0.15 57)"],
		["--heatmap-amber-4", "oklch(0.85 0.13 78)"],
	],
	blues: [
		["--heatmap-blues-0", "oklch(0.3 0.04 250)"],
		["--heatmap-blues-1", "oklch(0.43 0.09 250)"],
		["--heatmap-blues-2", "oklch(0.56 0.13 248)"],
		["--heatmap-blues-3", "oklch(0.69 0.15 240)"],
		["--heatmap-blues-4", "oklch(0.84 0.12 220)"],
	],
} as const satisfies Readonly<Record<string, ReadonlyArray<TokenWithFallback>>>

export const GROUT_TOKEN: TokenWithFallback = ["--heatmap-grout", "oklch(0.175 0.008 62)"]
