// The project page's right rail: its slowest functions, the hosts it calls most, and its recent
// build times.

import type { VercelDeploymentSummary, VercelInfraDependency, VercelInfraFunction } from "@maple/domain/http"
import { Array as Arr, Order, String as Str } from "effect"
import { buildDurationMs, isFailedBuild } from "./list-model"

const RAIL_ROWS = 4
const BUILD_BARS = 12

/** The routes with the highest p95. */
export const slowestFunctions = (
	functions: ReadonlyArray<VercelInfraFunction>,
): ReadonlyArray<VercelInfraFunction> =>
	Arr.take(
		Arr.sort(
			functions,
			Order.mapInput(Order.flip(Order.Number), (fn: VercelInfraFunction) => fn.p95DurationMs),
		),
		RAIL_ROWS,
	)

/** The hosts called most. */
export const topDependencies = (
	dependencies: ReadonlyArray<VercelInfraDependency>,
): ReadonlyArray<VercelInfraDependency> =>
	Arr.take(
		Arr.sort(
			dependencies,
			Order.mapInput(Order.flip(Order.Number), (dependency: VercelInfraDependency) => dependency.calls),
		),
		RAIL_ROWS,
	)

export type BuildOutcome = "ready" | "failed" | "canceled"

export type BuildBar = Readonly<{
	deployment: VercelDeploymentSummary
	/** Null for a canceled build Vercel reported no time for. */
	durationMs: number | null
	outcome: BuildOutcome
}>

export type BuildTimes = Readonly<{
	/** Oldest first. */
	bars: ReadonlyArray<BuildBar>
	/** Over the builds that reached ready; null without one. */
	medianMs: number | null
	failed: number
	canceled: number
}>

const median = (values: ReadonlyArray<number>): number | null => {
	const sorted = Arr.sort(values, Order.Number)
	const mid = Math.floor(sorted.length / 2)
	if (sorted.length === 0) return null
	return sorted.length % 2 === 1 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** The newest finished builds, oldest first: still building or queued ones have no time yet. */
export const buildTimes = (deployments: ReadonlyArray<VercelDeploymentSummary>): BuildTimes => {
	const finished = Arr.filter(deployments, (d) => buildDurationMs(d) !== null || isFailedBuild(d))
	const newest = Arr.take(
		Arr.sort(
			finished,
			Order.mapInput(Order.flip(Order.Number), (d: VercelDeploymentSummary) => d.createdAt),
		),
		BUILD_BARS,
	)
	const bars = Arr.map(Arr.reverse(newest), (deployment): BuildBar => {
		const outcome: BuildOutcome = !isFailedBuild(deployment)
			? "ready"
			: Str.toUpperCase(deployment.state) === "CANCELED"
				? "canceled"
				: "failed"
		return { deployment, durationMs: buildDurationMs(deployment), outcome }
	})
	const ready = Arr.filter(bars, (bar) => bar.outcome === "ready")
	return {
		bars,
		medianMs: median(Arr.flatMap(ready, (bar) => (bar.durationMs === null ? [] : [bar.durationMs]))),
		failed: Arr.filter(bars, (bar) => bar.outcome === "failed").length,
		canceled: Arr.filter(bars, (bar) => bar.outcome === "canceled").length,
	}
}
