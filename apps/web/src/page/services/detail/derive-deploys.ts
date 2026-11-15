import { parseWarehouseDateTime } from "@maple/query-engine"
import { Array as Arr, Option, Order } from "effect"
import { AsyncData } from "foldkit"
import type { Model } from "./model"
import type { DeployRow, ServiceDeploys } from "./model-deploys"

// Each deploy's first minutes against the minutes just before it, judged into one verdict.

/** Below this many spans on either side, a comparison is noise. */
const MIN_COMPARE_SPANS = 50
const ERROR_RATIO = 2
const ERROR_RATE_MIN_DIFF = 0.005
/** Rates are float quotients: 9/1000 - 4/1000 lands a hair under 0.005. */
const EPSILON = 1e-9
const P95_RATIO = 1.25
const P95_MIN_DIFF_MS = 10

/** Twice as often and at least half a point more; from none, half a point is enough. */
export const isErrorRateUp = (before: number, after: number): boolean =>
	after - before >= ERROR_RATE_MIN_DIFF - EPSILON &&
	(before === 0 || after / before >= ERROR_RATIO - EPSILON)

/** A quarter slower and at least 10ms, so a 4ms → 8ms hop on an idle endpoint is not flagged. */
export const isP95Up = (before: number, after: number): boolean =>
	before > 0 && after / before >= P95_RATIO - EPSILON && after - before >= P95_MIN_DIFF_MS - EPSILON

export type Verdict = "errors-up" | "slower" | "verifying" | "clean" | "unjudged"

export type Side = Readonly<{ spans: number; errorRate: number; p95Ms: number }>

export type DeployCheck = Readonly<{
	serviceName: string
	sha: string
	environment: string
	firstSeenMs: number
	verdict: Verdict
	/** Minutes of the after window that have elapsed, at most `windowMinutes`. */
	minutes: number
	windowMinutes: number
	before: Side
	after: Side
}>

const sideOf = (spans: number, errors: number, p95Ms: number): Side => ({
	spans,
	errorRate: spans > 0 ? errors / spans : 0,
	p95Ms,
})

/** Both sides carried enough spans for their comparison to mean something. */
export const isComparable = (check: Readonly<{ before: Side; after: Side }>): boolean =>
	check.before.spans >= MIN_COMPARE_SPANS && check.after.spans >= MIN_COMPARE_SPANS

/**
 * A flag beats "verifying": a deploy that is already failing says so before its window ends.
 * `dataEndMs` is where the read stops (now, or a past range's end): minutes after it were never read.
 */
export const judge = (row: DeployRow, windowSeconds: number, dataEndMs: number): DeployCheck => {
	const firstSeenMs = parseWarehouseDateTime(row.firstSeen)
	const windowMinutes = Math.round(windowSeconds / 60)
	const minutes = Math.max(0, Math.min(windowMinutes, Math.floor((dataEndMs - firstSeenMs) / 60_000)))
	const before = sideOf(row.beforeSpans, row.beforeErrors, row.beforeP95Ms)
	const after = sideOf(row.afterSpans, row.afterErrors, row.afterP95Ms)
	const comparable = isComparable({ before, after })
	const verdict: Verdict = !comparable
		? minutes < windowMinutes
			? "verifying"
			: "unjudged"
		: isErrorRateUp(before.errorRate, after.errorRate)
			? "errors-up"
			: isP95Up(before.p95Ms, after.p95Ms)
				? "slower"
				: minutes < windowMinutes
					? "verifying"
					: "clean"
	return {
		serviceName: row.serviceName,
		sha: row.commitSha,
		environment: row.environment,
		firstSeenMs,
		verdict,
		minutes,
		windowMinutes,
		before,
		after,
	}
}

export const isFlagged = (verdict: Verdict) => verdict === "errors-up" || verdict === "slower"

/**
 * One check per (commit, environment), newest first. A commit shipped to staging on Monday and to
 * production today is two deploys with two verdicts; merging them would show staging's.
 */
export const deployChecks = (deploys: ServiceDeploys, dataEndMs: number): ReadonlyArray<DeployCheck> =>
	Arr.sort(
		Arr.map(deploys.deploys, (row) => judge(row, deploys.verifyWindowSeconds, dataEndMs)),
		Order.flip(Order.mapInput(Order.Number, (check: DeployCheck) => check.firstSeenMs)),
	)

/** Where the page's read stops: now, or the end of a range in the past. */
export const dataEndOf = (model: Model): number => {
	const nowMs = model.nowMs ?? 0
	return model.window === null ? nowMs : Math.min(nowMs, parseWarehouseDateTime(model.window.endTime))
}

/**
 * Where the deploys answer on screen was read up to. While a range change refreshes, it is the old
 * answer's end, not the new window's: the issue tags and the verdicts must agree on it.
 */
export const deployDataEndOf = (model: Model): number =>
	AsyncData.getOrElse(
		AsyncData.map(model.deploys.data, (deploys) =>
			Math.min(model.nowMs ?? 0, parseWarehouseDateTime(deploys.readUntil)),
		),
		() => dataEndOf(model),
	)

/** The window's deploys judged on their first minutes; empty until they load. */
export const deployChecksOf = (model: Model): ReadonlyArray<DeployCheck> =>
	AsyncData.getOrElse(
		AsyncData.map(model.deploys.data, (deploys) => deployChecks(deploys, deployDataEndOf(model))),
		() => [],
	)

/** The deploy the page leads with: the newest flagged one, else the newest still verifying. */
export const leadDeploy = (checks: ReadonlyArray<DeployCheck>): DeployCheck | undefined =>
	Option.getOrUndefined(
		Option.orElse(
			Arr.findFirst(checks, (check) => isFlagged(check.verdict)),
			() => Arr.findFirst(checks, (check) => check.verdict === "verifying"),
		),
	)

/**
 * The newest deploy at or before `atMs`: the one an issue first seen then arrived with. An issue
 * first seen after the read ended (`endMs`) came with something this window does not show.
 */
export const deployBefore = (
	checks: ReadonlyArray<DeployCheck>,
	atMs: number,
	endMs: number,
): DeployCheck | undefined =>
	atMs > endMs
		? undefined
		: Option.getOrUndefined(Arr.findFirst(checks, (check) => check.firstSeenMs <= atMs))

/** The deploy the URL opens: its commit, and its environment when the URL names one. */
export const isOpenDeploy = (
	search: Readonly<{ deploy?: string | undefined; deployEnv?: string | undefined }>,
	check: DeployCheck,
): boolean =>
	search.deploy === check.sha && (search.deployEnv === undefined || search.deployEnv === check.environment)

/** The same deploy: one commit on one service and environment, however it was derived. */
export const isSameDeploy = (a: DeployCheck | undefined, b: DeployCheck): boolean =>
	a !== undefined && a.sha === b.sha && a.serviceName === b.serviceName && a.environment === b.environment

/** Flagged deploys first, then newest first: the rail leads with what needs a look. */
export const railOrder = (checks: ReadonlyArray<DeployCheck>): ReadonlyArray<DeployCheck> =>
	Arr.sort(
		checks,
		Order.combine(
			Order.flip(Order.mapInput(Order.Boolean, (check: DeployCheck) => isFlagged(check.verdict))),
			Order.flip(Order.mapInput(Order.Number, (check: DeployCheck) => check.firstSeenMs)),
		),
	)
