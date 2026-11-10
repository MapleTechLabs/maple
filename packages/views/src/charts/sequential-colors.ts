import { resolveSequentialDomain, type SequentialScaleType } from "./sequential-domain"
import { Array as Arr } from "effect"
import { parseOklch, rampColorAt } from "./oklch"

// `createSequentialColorScale` (./plot/color-scale.ts) without d3: the view needs the ramp's
// colours for legends, and d3-scale stays behind the chart Mount (S2).

/** `scaleSequential(…).clamp(true)` / `scaleSequentialLog(…).clamp(true)` as a plain function. */
export const sequentialColorScale = (options: {
	readonly stops: ReadonlyArray<string>
	readonly domain: readonly [number, number]
	readonly scaleType: SequentialScaleType
}): ((value: number) => string) => {
	const parsed = Arr.map(options.stops, parseOklch)
	const [lo, hi] = resolveSequentialDomain(options.domain, options.scaleType)
	const transform = options.scaleType === "log" ? Math.log : (value: number) => value
	const t0 = transform(lo)
	const t1 = transform(hi)
	const k = t0 === t1 ? 0 : 1 / (t1 - t0)
	return (value) => {
		const raw = k === 0 ? 0.5 : (transform(value) - t0) * k
		return rampColorAt(Math.max(0, Math.min(1, raw)), options.stops, parsed)
	}
}
