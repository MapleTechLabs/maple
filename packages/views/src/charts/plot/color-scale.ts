import type { PlotColorToken } from "./theme"
import { scaleSequential, scaleSequentialLog, type ScaleSequentialBase } from "d3-scale"
import { Array as Arr } from "effect"
import { parseOklch, rampColorAt } from "../oklch"
import { resolveSequentialDomain, type SequentialScaleType } from "../sequential-domain"

/**
 * Sequential colour scales for the TanStack charts spike.
 *
 * ## The scale is d3's, exactly as the docs prescribe
 *
 * `@tanstack/charts-scales@0.16.0` ships **band / linear / ordinal / point only** —
 * there is no colour scale in the package. The documented escape hatch (the
 * Legends and Color guide) is a d3 sequential scale: `ChartColorOptions.scale` is
 * typed as `ConfiguredColorScaleLike`, which is exactly d3's shape, and `d3-scale`
 * is a direct dependency of `apps/web` (the trace scatter already hands `scaleLog`
 * to its y axis). So `createSequentialColorScale` below is a thin wrapper over
 * `scaleSequential` / `scaleSequentialLog` — the domain / ticks / copy plumbing
 * this file used to hand-roll is d3's problem again.
 *
 * Two runtime facts verified against `@tanstack/charts/dist` keep that safe:
 *
 * - **The legend still classifies it `"continuous"`.** `colorScaleKind()`
 *   (`dist/scales.js:135`) returns `"continuous"` for a scale exposing `ticks`
 *   and none of `quantiles` / `thresholds` / `invertExtent`. d3's `sequential()`
 *   is `linearish(...)` and `sequentialLog()` is `loggish(...)`
 *   (`d3-scale/src/sequential.js`), so both carry `ticks` / `tickFormat` / `nice`
 *   and nothing from the quantile/threshold families — `colorGradientLegend`
 *   renders. (Surprise: `@types/d3-scale`'s `ScaleSequentialBase` omits `ticks`
 *   entirely; classification is a runtime property probe, so the types are
 *   irrelevant to it.)
 * - **`copy()` marks it a configured instance, not a factory.**
 *   `isColorScaleFactory` is `!("copy" in source)` (`dist/scales.js:79`), and
 *   every d3 scale has `copy` — so the runtime takes the configured branch, treats
 *   the pinned domain as authoritative, and never infers one from the colour
 *   channel. That is precisely what both call sites want: the heatmap pins
 *   `[min, max]` it computed itself, and the trace scatter pins a fixed density
 *   estimate the transform makes unknowable (see `DENSITY_DOMAIN` there).
 *
 * ## Why the interpolator is still hand-rolled
 *
 * `scaleSequential` accepts any `(t: number) => string`, and d3's stock
 * interpolators cannot produce Maple's ramps: `d3-scale-chromatic` palettes are
 * fixed, and anything routed through `d3-color` chokes on `var(--token)` — `NaN`
 * channels, rendered black. The stops live in `tokens.css` as
 * `--heatmap-<name>-0..4` and are resolved to `oklch(...)` literals via
 * `ResolveThemeColors` (re-resolved on theme flip) *before* they reach the ramp, so the
 * interpolator handed to d3 is a closure over resolved literals.
 *
 * The production heatmap blends flanking stops with CSS `color-mix(in oklch, …)` and lets
 * the browser do the mixing. Canvas takes literal colours, so that trick is unavailable
 * to a shared chart definition, so `mixOklch` (../oklch.ts) reproduces `color-mix(in oklch, …)`
 * numerically: componentwise on L and C, shorter-arc on H, which is what the CSS Color 4
 * `oklch` interpolation rule specifies.
 */

/**
 * The five-stop amber ramp, byte-for-byte the tokens the production heatmap uses.
 * Both light and dark are defined in `tokens.css`, and the ramp inverts between
 * them, so this has to be resolved through `usePlotColors` (which re-resolves on a
 * theme flip) rather than read once.
 */
export const HEATMAP_RAMP_TOKENS = {
	s0: ["--heatmap-amber-0", "oklch(0.32 0.035 70)"],
	s1: ["--heatmap-amber-1", "oklch(0.45 0.075 65)"],
	s2: ["--heatmap-amber-2", "oklch(0.58 0.115 60)"],
	s3: ["--heatmap-amber-3", "oklch(0.71 0.15 57)"],
	s4: ["--heatmap-amber-4", "oklch(0.85 0.13 78)"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

/** The blue ramp, for the scatter density so the two spikes are distinguishable. */
export const DENSITY_RAMP_TOKENS = {
	s0: ["--heatmap-blues-0", "oklch(0.3 0.04 250)"],
	s1: ["--heatmap-blues-1", "oklch(0.43 0.09 250)"],
	s2: ["--heatmap-blues-2", "oklch(0.56 0.13 248)"],
	s3: ["--heatmap-blues-3", "oklch(0.69 0.15 240)"],
	s4: ["--heatmap-blues-4", "oklch(0.84 0.12 220)"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

export type RampKey = "s0" | "s1" | "s2" | "s3" | "s4"

const RAMP_KEYS: readonly RampKey[] = ["s0", "s1", "s2", "s3", "s4"]

/** Flatten resolved ramp colours back into ordered ramp stops. */
export function rampStops(colors: Readonly<Record<RampKey, string>>): readonly string[] {
	return Arr.map(RAMP_KEYS, (key) => colors[key])
}

export interface SequentialColorScaleOptions {
	/** Resolved literal colours, low → high. `var(--token)` will NOT work. */
	stops: readonly string[]
	/** `[min, max]` of the value channel. */
	domain: readonly [number, number]
	scaleType: SequentialScaleType
}

export function createSequentialColorScale(
	options: SequentialColorScaleOptions,
): ScaleSequentialBase<string> {
	const { stops, scaleType } = options
	const resolved = resolveSequentialDomain(options.domain, scaleType)
	const parsed = Arr.map(stops, parseOklch)

	// The theme-aware half: a closure over the resolved token literals, in the
	// `(t: number) => string` shape `scaleSequential` takes as its interpolator.
	// `rampColorAt` clamps `t` itself, so even an unclamped scale could not walk off
	// the ramp — but `clamp(true)` below is still load-bearing for `scale(x)`'s
	// *inputs*: d3 extrapolates past the domain by default, and the trace
	// scatter's fixed density estimate relies on out-of-domain counts saturating
	// the top stop rather than extrapolating (the hand-rolled scale clamped too).
	const interpolator = (t: number): string => rampColorAt(t, stops, parsed)

	// Both branches return configured d3 instances. `dist/scales.js:79` treats any
	// callable with `copy` as configured (never a factory), so the pinned domain
	// is authoritative and nothing is inferred from the colour channel.
	if (scaleType === "log") {
		return scaleSequentialLog(interpolator).domain(resolved).clamp(true)
	}
	return scaleSequential(interpolator).domain(resolved).clamp(true)
}
