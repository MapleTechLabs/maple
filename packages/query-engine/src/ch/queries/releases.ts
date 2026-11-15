// Typed Releases Queries
//
// A release, for these queries, is a commit the moment it starts serving
// traffic: the service-overview rollups pre-extract `vcs.ref.head.revision` as
// `CommitSha` and key on it, so every row here is a GROUP BY over the same
// splice the services list already reads. Nothing scans the raw traces table.

import { Schema } from "effect"
import * as T from "@maple-dev/effect-orm/clickhouse"
import * as CH from "@maple-dev/effect-orm/expr"
import { param, fromQuery } from "@maple-dev/effect-orm/clickhouse"
import { CHNumber } from "../schema"
import { DateTimeUtcFromWarehouse } from "../../datetime"
import { serviceOverviewWindows } from "./services"

/**
 * At most this many (service, environment, commit) rows per request. A fleet
 * that deploys every push accumulates thousands of shas in a month; the page
 * lists the newest and says how many it left out.
 */
export const RELEASES_LIST_CAP = 500

/**
 * Values an SDK writes into `vcs.ref.head.revision` when it has no revision
 * to report. They are not releases: the services table drops them from its
 * deploy cell, and one of them showing up here as "errors from 0" was the
 * first thing the page did against live data.
 */
export const PLACEHOLDER_COMMIT_SHAS: readonly string[] = ["", "unknown", "N/A"]

export interface ReleasesListOpts {
	readonly serviceName?: string
	readonly serviceNames?: readonly string[]
	readonly environments?: readonly string[]
	readonly namespaces?: readonly string[]
	readonly excludedEnvironments?: readonly string[]
	readonly excludedNamespaces?: readonly string[]
	readonly limit?: number
}

export const releasesListRowSchema = Schema.Struct({
	serviceName: Schema.String,
	environment: Schema.String,
	commitSha: Schema.String,
	firstSeen: DateTimeUtcFromWarehouse,
	// `CHNumber`, never `Schema.Number`: UInt64 counts arrive quoted on a
	// gateway that refuses `output_format_json_quote_64bit_integers=0`.
	spanCount: CHNumber,
	errorCount: CHNumber,
	p50LatencyMs: CHNumber,
	p95LatencyMs: CHNumber,
	p99LatencyMs: CHNumber,
	apdexSatisfiedCount: CHNumber,
	apdexToleratingCount: CHNumber,
})

export type ReleasesListOutput = typeof releasesListRowSchema.Type

/**
 * One row per (service, environment, commit) in the window, newest first.
 *
 * Every version of a service is a row, not just the latest — a release's
 * impact is "this version against every other version of the same service in
 * the same minutes", and the caller derives that split from these rows.
 */
export function releasesListQuery(opts: ReleasesListOpts = {}) {
	return serviceOverviewWindows({
		serviceName: opts.serviceName,
		environments: opts.environments,
		namespaces: opts.namespaces,
		excludedEnvironments: opts.excludedEnvironments,
		excludedNamespaces: opts.excludedNamespaces,
	})
		.select(($) => ({
			serviceName: $.bServiceName,
			environment: $.bEnvironment,
			commitSha: $.bCommitSha,
			firstSeen: CH.min_($.bFirstSeen),
			spanCount: CH.sum($.bSpanCount),
			errorCount: CH.sum($.bErrorCount),
			p50LatencyMs: CH.rawExpr(
				"arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000",
				T.float64,
			),
			p95LatencyMs: CH.rawExpr(
				"arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000",
				T.float64,
			),
			p99LatencyMs: CH.rawExpr(
				"arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000",
				T.float64,
			),
			apdexSatisfiedCount: CH.sum($.bApdexSatisfiedCount),
			apdexToleratingCount: CH.sum($.bApdexToleratingCount),
		}))
		.where(($) => [
			CH.notInList($.bCommitSha, PLACEHOLDER_COMMIT_SHAS),
			opts.serviceNames !== undefined && opts.serviceNames.length > 0
				? CH.inList($.bServiceName, opts.serviceNames)
				: undefined,
		])
		.groupBy("serviceName", "environment", "commitSha")
		.orderBy(["firstSeen", "desc"], ["spanCount", "desc"])
		.limit(opts.limit ?? RELEASES_LIST_CAP)
		.format("JSON")
}

// Which commit each service served traffic from in the window, for the dependency scanner: a
// vulnerable package matters most in the commit a busy service is running.

/** At most this many (service, environment, commit) rows, busiest first. */
export const RUNNING_COMMITS_CAP = 200

export const runningCommitsRowSchema = Schema.Struct({
	serviceName: Schema.String,
	environment: Schema.String,
	commitSha: Schema.String,
	spanCount: CHNumber,
})

export type RunningCommitsOutput = typeof runningCommitsRowSchema.Type

/** The releases list without its latency and error columns, ordered by traffic. */
export function runningCommitsQuery() {
	return serviceOverviewWindows({})
		.select(($) => ({
			serviceName: $.bServiceName,
			environment: $.bEnvironment,
			commitSha: $.bCommitSha,
			// Sample-weighted, so a sampled service ranks by the traffic it served.
			spanCount: CH.sum($.bEstimatedSpanCount),
		}))
		.where(($) => [CH.notInList($.bCommitSha, PLACEHOLDER_COMMIT_SHAS)])
		.groupBy("serviceName", "environment", "commitSha")
		.orderBy(["spanCount", "desc"])
		.limit(RUNNING_COMMITS_CAP)
		.format("JSON")
}

// The releases list plus when each version last served, for deploy
// verification in one call. `lastSeen` is the start of the last bucket the
// version had traffic in: minute precision without the hourly tier, hour
// precision for hours wholly inside the window with it.

export interface ServiceDeploymentsOpts {
	readonly serviceName?: string
	readonly environments?: readonly string[]
	/** Read minutely buckets for the whole window so `lastSeen` is minute-exact. */
	readonly minutePrecision: boolean
	readonly limit?: number
	/** Versions kept per (service, environment), most recently serving first. */
	readonly perServiceLimit?: number
}

export const serviceDeploymentsRowSchema = Schema.Struct({
	...releasesListRowSchema.fields,
	lastSeen: DateTimeUtcFromWarehouse,
})

export type ServiceDeploymentsOutput = typeof serviceDeploymentsRowSchema.Type

export const DEPLOYMENTS_PER_SERVICE_CAP = 20

type DeploymentKey = keyof ServiceDeploymentsOutput

const deploymentColumns = <A extends { readonly [K in DeploymentKey]: unknown }>(
	$: A,
): Pick<A, DeploymentKey> => ({
	serviceName: $.serviceName,
	environment: $.environment,
	commitSha: $.commitSha,
	firstSeen: $.firstSeen,
	lastSeen: $.lastSeen,
	spanCount: $.spanCount,
	errorCount: $.errorCount,
	p50LatencyMs: $.p50LatencyMs,
	p95LatencyMs: $.p95LatencyMs,
	p99LatencyMs: $.p99LatencyMs,
	apdexSatisfiedCount: $.apdexSatisfiedCount,
	apdexToleratingCount: $.apdexToleratingCount,
})

export function serviceDeploymentsQuery(opts: ServiceDeploymentsOpts) {
	const versions = serviceOverviewWindows(
		{ serviceName: opts.serviceName, environments: opts.environments },
		{ grain: "minute", includeHourly: !opts.minutePrecision },
	)
		.select(($) => ({
			serviceName: $.bServiceName,
			environment: $.bEnvironment,
			commitSha: $.bCommitSha,
			firstSeen: CH.min_($.bFirstSeen),
			lastSeen: CH.max_($.bBucket),
			spanCount: CH.sum($.bSpanCount),
			errorCount: CH.sum($.bErrorCount),
			p50LatencyMs: CH.rawExpr(
				"arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 1) / 1000000",
				T.float64,
			),
			p95LatencyMs: CH.rawExpr(
				"arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 2) / 1000000",
				T.float64,
			),
			p99LatencyMs: CH.rawExpr(
				"arrayElement(quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3) / 1000000",
				T.float64,
			),
			apdexSatisfiedCount: CH.sum($.bApdexSatisfiedCount),
			apdexToleratingCount: CH.sum($.bApdexToleratingCount),
		}))
		.where(($) => [CH.notInList($.bCommitSha, PLACEHOLDER_COMMIT_SHAS)])
		.groupBy("serviceName", "environment", "commitSha")

	// Rank inside each (service, environment) so one fast-deploying service
	// cannot crowd the others out of the global limit.
	const ranked = fromQuery(versions, "versions").select(($) => ({
		...deploymentColumns($),
		versionRank: CH.rawExpr(
			"row_number() OVER (PARTITION BY serviceName, environment ORDER BY lastSeen DESC, firstSeen DESC)",
			T.uint64,
		),
	}))

	return fromQuery(ranked, "ranked")
		.select(($) => deploymentColumns($))
		.where(($) => [$.versionRank.lte(opts.perServiceLimit ?? DEPLOYMENTS_PER_SERVICE_CAP)])
		.orderBy(["serviceName", "asc"], ["firstSeen", "desc"])
		.limit(opts.limit ?? RELEASES_LIST_CAP)
		.format("JSON")
}

// Deploy verification: each version's first minutes against the same number of
// minutes just before it on the same (service, environment). A time-matched
// window, so a deploy at 3am is not judged against the afternoon peak and a
// version that lived ten minutes is not judged against one that lived a week.

/** The window on each side of a deploy. */
export const DEPLOY_VERIFY_WINDOW_SECONDS = 30 * 60

export const releaseVerificationRowSchema = Schema.Struct({
	serviceName: Schema.String,
	environment: Schema.String,
	commitSha: Schema.String,
	firstSeen: DateTimeUtcFromWarehouse,
	afterSpans: CHNumber,
	afterErrors: CHNumber,
	afterP95Ms: CHNumber,
	beforeSpans: CHNumber,
	beforeErrors: CHNumber,
	beforeP95Ms: CHNumber,
})

export type ReleaseVerificationOutput = typeof releaseVerificationRowSchema.Type

/** The services one commit reached in the window: what bounds a commit's verification read. */
export function commitServicesQuery(commitSha: string) {
	return serviceOverviewWindows({ commitShas: [commitSha] })
		.select(($) => ({ serviceName: $.bServiceName }))
		.groupBy("serviceName")
		.limit(RELEASES_LIST_CAP)
		.format("JSON")
}

export const commitServicesRowSchema = Schema.Struct({ serviceName: Schema.String })

export interface ReleaseVerificationOpts {
	readonly serviceName?: string
	readonly environments?: readonly string[]
	/** One commit across every service it reached. */
	readonly commitSha?: string
	/** Bounds the minutes read to these services (the ones a commit reached). */
	readonly serviceNames?: readonly string[]
	readonly limit?: number
}

/**
 * Reads `[startTime, endTime]` but keeps only versions first seen at or after `deploysFrom`:
 * the caller starts the read early, so a version already running is not taken for a deploy and a
 * deploy near `deploysFrom` still has its minutes before.
 */
export function releaseVerificationQuery(opts: ReleaseVerificationOpts = {}) {
	const filters = { serviceName: opts.serviceName, environments: opts.environments }
	const windowMinutes = DEPLOY_VERIFY_WINDOW_SECONDS / 60
	const inServices = <A extends { bServiceName: CH.Expr<string> }>($: A) =>
		opts.serviceNames === undefined ? undefined : CH.inList($.bServiceName, opts.serviceNames)

	const deploys = serviceOverviewWindows(filters)
		.select(($) => ({
			serviceName: $.bServiceName,
			environment: $.bEnvironment,
			commitSha: $.bCommitSha,
			firstSeen: CH.min_($.bFirstSeen),
		}))
		.where(($) => [
			CH.notInList($.bCommitSha, PLACEHOLDER_COMMIT_SHAS),
			CH.when(opts.commitSha, (sha: string) => $.bCommitSha.eq(sha)),
			inServices($),
		])
		.groupBy("serviceName", "environment", "commitSha")
		.having(($) => [CH.min_($.bFirstSeen).gte(param.dateTime("deploysFrom"))])
		.orderBy(["firstSeen", "desc"])
		.limit(opts.limit ?? RELEASES_LIST_CAP)

	// Each deploy fanned out to the minutes either side of it, so the join matches only those
	// minutes rather than every minute of the window.
	const deployMinutes = fromQuery(deploys, "deploys").select(($) => ({
		dServiceName: $.serviceName,
		dEnvironment: $.environment,
		dCommitSha: $.commitSha,
		dFirstSeen: $.firstSeen,
		dOffset: CH.rawExpr(`arrayJoin(range(-${windowMinutes}, ${windowMinutes}))`, T.int64),
		dBucket: CH.rawExpr("toStartOfMinute(firstSeen) + toIntervalMinute(dOffset)", T.dateTime),
	}))

	// Minute precision across the whole window: the hourly tier cannot place a deploy inside its hour.
	const minutes = serviceOverviewWindows(filters, { grain: "minute", includeHourly: false })
		.select(($) => ({
			mBucket: $.bBucket,
			mServiceName: $.bServiceName,
			mEnvironment: $.bEnvironment,
			mCommitSha: $.bCommitSha,
			mSpans: $.bSpanCount,
			mErrors: $.bErrorCount,
			mQuantiles: $.bDurationQuantiles,
		}))
		// Placeholder shas stay: a version that reported none is still the traffic before a deploy.
		// The after side only ever counts the deployed commit.
		.where(($) => [inServices($)])

	const after = "minutes.mCommitSha = deployMinutes.dCommitSha AND deployMinutes.dOffset >= 0"
	const before = "minutes.mCommitSha != deployMinutes.dCommitSha AND deployMinutes.dOffset < 0"
	const p95 = (cond: string) =>
		CH.rawExpr(
			`ifNotFinite(arrayElement(quantilesTDigestMergeIf(0.5, 0.95, 0.99)(minutes.mQuantiles, ${cond}), 2) / 1000000, 0)`,
			T.float64,
		)

	// A left join: past the minute rollup's retention a deploy still lists, with nothing to judge.
	return fromQuery(deployMinutes, "deployMinutes")
		.leftJoinQuery(minutes, "minutes", (deploy, minute) =>
			deploy.dServiceName
				.eq(minute.mServiceName)
				.and(deploy.dEnvironment.eq(minute.mEnvironment))
				.and(deploy.dBucket.eq(minute.mBucket)),
		)
		.select(($) => ({
			serviceName: $.dServiceName,
			environment: $.dEnvironment,
			commitSha: $.dCommitSha,
			firstSeen: CH.min_($.dFirstSeen),
			afterSpans: CH.rawExpr(`sumIf(minutes.mSpans, ${after})`, T.uint64),
			afterErrors: CH.rawExpr(`sumIf(minutes.mErrors, ${after})`, T.uint64),
			afterP95Ms: p95(after),
			beforeSpans: CH.rawExpr(`sumIf(minutes.mSpans, ${before})`, T.uint64),
			beforeErrors: CH.rawExpr(`sumIf(minutes.mErrors, ${before})`, T.uint64),
			beforeP95Ms: p95(before),
		}))
		.groupBy("serviceName", "environment", "commitSha")
		.orderBy(["firstSeen", "desc"])
		.limit(opts.limit ?? RELEASES_LIST_CAP)
		.format("JSON")
}
