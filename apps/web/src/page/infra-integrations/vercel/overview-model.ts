// Pure models behind the /infra/vercel overview: each project's worst signal and the health
// filters over it, the linked strips' rows and the deploy markers.

import type {
	VercelDeploymentSummary,
	VercelInfraLatencyBucket,
	VercelInfraRequestBucket,
} from "@maple/domain/http"
import { ERROR_RATE_WARN } from "@maple/ui/lib/error-rate"
import type { CommitMarker } from "../../kit/service-metrics/marker-layout"
import type { ChartEventMarker } from "@maple/views/charts/event-marker-spec"
import { Array as Arr, Order, String as Str } from "effect"
import type { VercelProjectScope } from "@/route/search"
import {
	type DeployRegression,
	deployTitle,
	deployCommitMarkers,
	regressionBands,
	deployRegressions,
	productionDeploysIn,
} from "./deploy-signals"
import type { VercelProjectRow } from "./list-model"

/** A project's p95 at or over this is slow. */
export const SLOW_P95_MS = 1_000
/** Cold starts at or over this share of invocations, 0–100. */
export const COLD_START_HEAVY_PERCENT = 10

export type Window = Readonly<{ startMs: number; endMs: number }>

const isErroring = (row: VercelProjectRow) =>
	row.errorPercent !== null && row.errorPercent >= ERROR_RATE_WARN * 100

/** The project's newest deployment failed, and it was created inside the window. */
const hasFailedDeploy = (row: VercelProjectRow, window: Window) =>
	row.latest !== null &&
	Str.toUpperCase(row.latest.state) === "ERROR" &&
	row.latest.createdAt >= window.startMs

const isSlow = (row: VercelProjectRow) => row.p95DurationMs !== null && row.p95DurationMs >= SLOW_P95_MS

const isColdStartHeavy = (row: VercelProjectRow) =>
	row.coldStartPercent !== null && row.coldStartPercent >= COLD_START_HEAVY_PERCENT

export const inScope = (row: VercelProjectRow, scope: VercelProjectScope, window: Window): boolean => {
	switch (scope) {
		case "erroring":
			return isErroring(row)
		case "failedDeploys":
			return hasFailedDeploy(row, window)
		case "slow":
			return isSlow(row)
		case "coldStarts":
			return isColdStartHeavy(row)
	}
}

/** A project's worst signal, worst first. */
export const PROJECT_HEALTH = ["erroring", "failedDeploy", "slow", "coldStarts", "healthy", "idle"] as const
export type ProjectHealth = (typeof PROJECT_HEALTH)[number]

export const projectHealth = (row: VercelProjectRow, window: Window): ProjectHealth =>
	isErroring(row)
		? "erroring"
		: hasFailedDeploy(row, window)
			? "failedDeploy"
			: row.requests === 0 && row.invocations === 0
				? "idle"
				: isSlow(row)
					? "slow"
					: isColdStartHeavy(row)
						? "coldStarts"
						: "healthy"

/** Problems first (the worst signal), then the busiest, then by name. */
export const problemsFirst = (
	rows: ReadonlyArray<VercelProjectRow>,
	window: Window,
): ReadonlyArray<VercelProjectRow> =>
	Arr.sort(
		rows,
		Order.combineAll([
			Order.mapInput(Order.Number, (row: VercelProjectRow) =>
				PROJECT_HEALTH.indexOf(projectHealth(row, window)),
			),
			Order.mapInput(Order.flip(Order.Number), (row: VercelProjectRow) => row.requests),
			Order.mapInput(Order.String, (row: VercelProjectRow) => row.name),
		]),
	)

/** The deploy the table shows: the newest when it went to production, else what serves production. */
export const productionDeployOf = (row: VercelProjectRow): VercelDeploymentSummary | null =>
	row.latest !== null && row.latest.target === "production" ? row.latest : row.production

// Strips

type StripRow = { bucket: string; attributeValue: string; value: number }

/** 5xx share of each bucket's requests, 0–1; buckets without requests are skipped. */
export const serverErrorRateRows = (buckets: ReadonlyArray<VercelInfraRequestBucket>): StripRow[] =>
	Arr.flatMap(buckets, (b) =>
		b.requests === 0
			? []
			: [{ bucket: b.bucket, attributeValue: "5xx", value: b.requests5xx / b.requests }],
	)

/** Cache hits over cache lookups per bucket, 0–1; buckets with no lookups are skipped. */
export const cacheHitRows = (buckets: ReadonlyArray<VercelInfraRequestBucket>): StripRow[] =>
	Arr.flatMap(buckets, (b) =>
		b.cacheLookups === 0
			? []
			: [{ bucket: b.bucket, attributeValue: "", value: b.cacheHits / b.cacheLookups }],
	)

/** `Invoke Function` p95 and p50 per bucket; buckets without invocations are skipped. */
export const functionLatencyRows = (buckets: ReadonlyArray<VercelInfraLatencyBucket>): StripRow[] =>
	Arr.flatMap(buckets, (b) => [
		...(b.invokeP95Ms === null
			? []
			: [{ bucket: b.bucket, attributeValue: "p95", value: b.invokeP95Ms }]),
		...(b.invokeP50Ms === null
			? []
			: [{ bucket: b.bucket, attributeValue: "p50", value: b.invokeP50Ms }]),
	])

const median = (values: ReadonlyArray<number>): number | null => {
	const sorted = Arr.sort(values, Order.Number)
	return sorted.length === 0 ? null : (sorted[Math.floor(sorted.length / 2)] ?? null)
}

/** The worst bucket's 5xx share, 0–1; null without requests. */
export const peakServerErrorRate = (buckets: ReadonlyArray<VercelInfraRequestBucket>): number | null => {
	const rates = Arr.map(serverErrorRateRows(buckets), (row) => row.value)
	return rates.length === 0 ? null : Math.max(...rates)
}

/** The typical bucket's function p95 and p50 (their medians) and the worst p95; null without invocations. */
export const functionLatencySummary = (
	buckets: ReadonlyArray<VercelInfraLatencyBucket>,
): Readonly<{ p95: number; p50: number | null; peakP95: number }> | null => {
	const p95s = Arr.flatMap(buckets, (b) => (b.invokeP95Ms === null ? [] : [b.invokeP95Ms]))
	const p95 = median(p95s)
	if (p95 === null) return null
	return {
		p95,
		p50: median(Arr.flatMap(buckets, (b) => (b.invokeP50Ms === null ? [] : [b.invokeP50Ms]))),
		peakP95: Math.max(...p95s),
	}
}

/**
 * The team's production deploys in the window as chart markers, labelled with the project and
 * short sha; the ones followed by a 5xx jump in the team's request series are the regressions.
 */
export const teamDeploySignals = (
	inputs: Readonly<{
		deployments: ReadonlyArray<VercelDeploymentSummary>
		buckets: ReadonlyArray<VercelInfraRequestBucket>
		window: Window
		bucketMs: number
		projectName: (projectId: string) => string
	}>,
): Readonly<{
	markers: ReadonlyArray<ChartEventMarker>
	commits: ReadonlyArray<CommitMarker>
	regressions: ReadonlyArray<DeployRegression>
}> => {
	const deploys = productionDeploysIn(inputs.deployments, inputs.window)
	const regressions = deployRegressions(inputs.buckets, deploys, inputs.bucketMs)
	return {
		markers: regressionBands(regressions),
		commits: deployCommitMarkers(
			deploys,
			(deployment) => `${inputs.projectName(deployment.projectId)} · ${deployTitle(deployment)}`,
		),
		regressions,
	}
}
