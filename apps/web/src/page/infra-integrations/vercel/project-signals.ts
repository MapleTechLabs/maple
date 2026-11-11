// The project page's linked strips: per-bucket rates from the log drain's requests and the trace
// drain's latency, and the production deploys drawn over them.

import type {
	VercelDeploymentSummary,
	VercelInfraFunctionBucket,
	VercelInfraLatencyBucket,
	VercelInfraRequestBucket,
} from "@maple/domain/http"
import { toEpochMs } from "@maple/ui/lib/time-format"
import type { CommitMarker } from "../../kit/service-metrics/marker-layout"
import type { ChartEventMarker } from "@maple/views/charts/event-marker-spec"
import type { LongRow } from "@maple/views/charts/infra-metric-series"
import { Array as Arr } from "effect"
import {
	type DeployRegression,
	deployCommitMarkers,
	regressionBands,
	deployRegressions,
	productionDeploysIn,
} from "./deploy-signals"

const share = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null)

/** One series per name; a bucket whose value is null (no denominator, no spans) draws nothing. */
const rowsOf = <B extends { readonly bucket: string }>(
	buckets: ReadonlyArray<B>,
	series: ReadonlyArray<readonly [name: string, pick: (bucket: B) => number | null]>,
): ReadonlyArray<LongRow> =>
	Arr.flatMap(buckets, (bucket) =>
		Arr.flatMap(series, ([name, pick]) => {
			const value = pick(bucket)
			return value === null ? [] : [{ bucket: bucket.bucket, attributeValue: name, value }]
		}),
	)

/** The functions tab's strips: invocations, cold-start share, duration and cold-start init time. */
export const functionRows = (buckets: ReadonlyArray<VercelInfraFunctionBucket>) => ({
	invocations: rowsOf(buckets, [["value", (b) => b.invocations]]),
	coldStarts: rowsOf(buckets, [["value", (b) => share(b.coldStarts, b.invocations)]]),
	// A bucket without an invocation (or a cold start) has no duration: no point, not a zero.
	duration: rowsOf(buckets, [
		["p50", (b) => (b.invocations > 0 ? b.p50DurationMs : null)],
		["p95", (b) => (b.invocations > 0 ? b.p95DurationMs : null)],
	]),
	init: rowsOf(buckets, [
		["p50", (b) => (b.coldStarts > 0 ? b.initP50Ms : null)],
		["p95", (b) => (b.coldStarts > 0 ? b.initP95Ms : null)],
	]),
})

/** A zero bucket for `fillBuckets`. */
export const zeroFunctionBucket = (bucket: string): VercelInfraFunctionBucket => ({
	bucket,
	invocations: 0,
	coldStarts: 0,
	p50DurationMs: 0,
	p95DurationMs: 0,
	initP50Ms: 0,
	initP95Ms: 0,
})

/** 5xx share of each bucket's requests, 0–1. */
export const serverErrorRateRows = (buckets: ReadonlyArray<VercelInfraRequestBucket>) =>
	rowsOf(buckets, [["value", (b) => share(b.requests5xx, b.requests)]])

/** Cache hits over cache lookups, 0–1. */
export const cacheHitRows = (buckets: ReadonlyArray<VercelInfraRequestBucket>) =>
	rowsOf(buckets, [["value", (b) => share(b.cacheHits, b.cacheLookups)]])

/** p95 at the edge and of `Invoke Function`, in ms. */
export const latencyRows = (buckets: ReadonlyArray<VercelInfraLatencyBucket>) =>
	rowsOf(buckets, [
		["edge", (b) => b.edgeP95Ms],
		["function", (b) => b.invokeP95Ms],
	])

/** Cold starts over invocations, 0–1. */
export const coldStartRows = (buckets: ReadonlyArray<VercelInfraLatencyBucket>) =>
	rowsOf(buckets, [["value", (b) => share(b.coldStarts, b.invocations)]])

export type ProjectTotals = Readonly<{
	requests: number
	/** 5xx share of requests, 0–1; null without requests. */
	serverErrorRate: number | null
	requests5xx: number
	/** Null when nothing was looked up in the cache. */
	cacheHitRate: number | null
	cacheLookups: number
	invocations: number
	/** Null without invocations. */
	coldStartRate: number | null
}>

const sum = <B>(buckets: ReadonlyArray<B>, pick: (bucket: B) => number) =>
	Arr.reduce(buckets, 0, (total, bucket) => total + pick(bucket))

/** The window's totals behind the strips' summaries. */
export const projectTotals = (
	buckets: ReadonlyArray<VercelInfraRequestBucket>,
	latency: ReadonlyArray<VercelInfraLatencyBucket>,
): ProjectTotals => {
	const requests = sum(buckets, (b) => b.requests)
	const requests5xx = sum(buckets, (b) => b.requests5xx)
	const cacheLookups = sum(buckets, (b) => b.cacheLookups)
	const invocations = sum(latency, (b) => b.invocations)
	return {
		requests,
		requests5xx,
		serverErrorRate: share(requests5xx, requests),
		cacheLookups,
		cacheHitRate: share(
			sum(buckets, (b) => b.cacheHits),
			cacheLookups,
		),
		invocations,
		coldStartRate: share(
			sum(latency, (b) => b.coldStarts),
			invocations,
		),
	}
}

export type DeploySignals = Readonly<{
	regressions: ReadonlyArray<DeployRegression>
	/** The regressions' bands, drawn in the charts. */
	markers: ReadonlyArray<ChartEventMarker>
	/** Every deploy in the window, as the commit-marker overlay's dashes and labels. */
	commits: ReadonlyArray<CommitMarker>
}>

/**
 * The project's production deploys in the window as chart markers, and the ones followed by a
 * jump in 5xx. `buckets` must be the window's filled grid of `bucketSeconds`.
 */
/** The window's production deploys as commit markers, for strips that show no regression. */
export const projectDeployCommits = (
	deployments: ReadonlyArray<VercelDeploymentSummary>,
	window: Readonly<{ startTime: string; endTime: string }>,
): ReadonlyArray<CommitMarker> =>
	deployCommitMarkers(
		productionDeploysIn(deployments, {
			startMs: toEpochMs(window.startTime),
			endMs: toEpochMs(window.endTime),
		}),
	)

export const projectDeploySignals = (
	buckets: ReadonlyArray<VercelInfraRequestBucket>,
	deployments: ReadonlyArray<VercelDeploymentSummary>,
	window: Readonly<{ startTime: string; endTime: string; bucketSeconds: number }>,
): DeploySignals => {
	const deploys = productionDeploysIn(deployments, {
		startMs: toEpochMs(window.startTime),
		endMs: toEpochMs(window.endTime),
	})
	const regressions = deployRegressions(buckets, deploys, window.bucketSeconds * 1000)
	return { regressions, markers: regressionBands(regressions), commits: deployCommitMarkers(deploys) }
}
