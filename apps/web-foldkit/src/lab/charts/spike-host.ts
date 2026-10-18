import { Option } from "effect"
import {
	type ChartHost,
	type ChartHostOptions,
	createChartHost as createProductionHost,
	hostFor,
} from "../../charts/chart-host"
import type { ChartSpec } from "../../charts/chart-spec"
import type { SpikeSpec } from "./spike-spec"
import { buildAreaSpike, buildLineSpike } from "./spike-timeseries"

/**
 * The `/lab/charts` prototypes' chart host: a `LabSpike` spec is built by its arm's definition,
 * anything else by the production host. Loaded by `MountChart host: "lab"`, only on the lab page.
 */

const isSpike = (spec: ChartSpec): spec is SpikeSpec => spec._tag === "LabSpike"

/** The spec, while it is still this arm's: an arm swap means a new host. */
const armOf =
	(arm: string) =>
	(spec: ChartSpec): Option.Option<SpikeSpec> =>
		isSpike(spec) && spec.arm === arm ? Option.some(spec) : Option.none()

const spikeHost = (container: HTMLElement, spec: SpikeSpec, height: number, options: ChartHostOptions): ChartHost => {
	const narrow = armOf(spec.arm)
	switch (spec.arm) {
		case "line-tanstack":
		case "line-incomplete-tanstack":
		case "line-legend-tanstack":
			return hostFor(container, spec, height, narrow, buildLineSpike, options)
		case "area-tanstack":
		case "area-incomplete-tanstack":
		case "area-legend-tanstack":
			return hostFor(container, spec, height, narrow, buildAreaSpike, options)
		default:
			return { update: () => false, destroy: () => undefined }
	}
}

export const createChartHost = (
	container: HTMLElement,
	spec: ChartSpec,
	height: number,
	options: ChartHostOptions,
): ChartHost =>
	isSpike(spec) ? spikeHost(container, spec, height, options) : createProductionHost(container, spec, height, options)
