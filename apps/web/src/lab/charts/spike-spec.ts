import type { ChartSpec } from "@maple/views/charts/chart-spec"
import { Array as Arr } from "effect"

// The `/lab/charts` prototypes' spec (`ChartSpec.LabSpike`) and the emphasis helpers they share.

export type SpikeSpec = Extract<ChartSpec, { readonly _tag: "LabSpike" }>

/** `MUTED_OPACITY` (plot-legend.tsx): how far a non-highlighted series fades. */
export const MUTED_OPACITY = 0.22

/** The series a pinned legend row pushes back: every other one. */
export const mutedOf = (spec: SpikeSpec, ids: ReadonlyArray<string>): ReadonlySet<string> =>
	new Set(spec.highlighted === null ? [] : Arr.filter(ids, (id) => id !== spec.highlighted))
