// The Security Center's telemetry tabs.
// - Exposure: `scanner_requests`, Server spans that probe for secrets, source control, debug
//   endpoints and known exploits, or come from a named scanning tool.
// - Runtimes: `service_runtimes_hourly`, the runtime and telemetry SDK each service reports.

import * as CH from "@maple-dev/effect-orm/expr"
import type { DateTime } from "effect"
import { param, from } from "@maple-dev/effect-orm/clickhouse"
import type { CHQuery, ColumnDefs, ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import * as T from "@maple-dev/effect-orm/clickhouse"
import { AUTONOMOUS_SCANNER_NAMES, CRITICAL_PROBE_SIGNATURES } from "@maple/domain/security-telemetry"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { orgIdParam, utcSecondsParam } from "../tables"
import { utcHourFloor } from "./query-helpers"
import { Array as Arr } from "effect"

type ScannerAccessor = ColumnAccessor<typeof Datasources.scannerRequests.columns>

function scannerWhere($: ScannerAccessor) {
	return [
		$.OrgId.eq(orgIdParam),
		$.Timestamp.gte(param.dateTime("startTime")),
		$.Timestamp.lte(param.dateTime("endTime")),
	]
}

/** The service answered with a success: whatever was probed for was likely served. */
const answered = ($: ScannerAccessor) => $.HttpStatus.gte(200).and($.HttpStatus.lt(300))

export interface ScannerSignaturesOutput {
	/** A `PROBE_SIGNATURES` token, `''` for a named scanner on an ordinary path. */
	readonly signature: string
	readonly service: string
	readonly requests: number
	readonly answered: number
	readonly sources: number
	readonly lastSeen: DateTime.Utc
}

/** Most signature rows returned: about fifty signatures for each of a hundred probed services. */
export const SCANNER_SIGNATURES_MAX_ROWS = 5000

/** Requests per probe signature and service. Bounded: a few dozen signatures per service. */
export function scannerSignaturesQuery(): CHQuery<ColumnDefs, ScannerSignaturesOutput> {
	return from(Datasources.scannerRequests)
		.select(($) => ({
			signature: $.Signature,
			service: $.ServiceName,
			// uniq, not count: a proxied request has several Server spans.
			requests: CH.uniq($.TraceId),
			answered: CH.uniqIf($.TraceId, answered($)),
			sources: CH.uniqIf($.ClientAddress, $.ClientAddress.neq("")),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(scannerWhere)
		.groupBy("signature", "service")
		.orderBy(["requests", "desc"])
		.limit(SCANNER_SIGNATURES_MAX_ROWS)
		.format("JSON")
}

export interface ScannerExposedOpts {
	readonly limit?: number
}

export interface ScannerExposedOutput {
	readonly service: string
	readonly host: string
	readonly path: string
	readonly signature: string
	readonly httpStatus: number
	readonly requests: number
	readonly lastSeen: DateTime.Utc
	readonly sampleTraceId: string
}

/** Probes on a critical signature that the service answered with a 2xx: the paths to check now. */
export function scannerExposedQuery(
	opts: ScannerExposedOpts = {},
): CHQuery<ColumnDefs, ScannerExposedOutput> {
	return from(Datasources.scannerRequests)
		.select(($) => ({
			service: $.ServiceName,
			host: $.Host,
			path: $.Path,
			signature: $.Signature,
			httpStatus: $.HttpStatus,
			requests: CH.uniq($.TraceId),
			lastSeen: CH.max_($.Timestamp),
			sampleTraceId: CH.any_($.TraceId),
		}))
		.where(($) => [
			...scannerWhere($),
			CH.inList(
				$.Signature,
				Arr.map(CRITICAL_PROBE_SIGNATURES, (signature) => signature.token),
			),
			answered($),
		])
		.groupBy("service", "host", "path", "signature", "httpStatus")
		.orderBy(["lastSeen", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}

export interface ScannerSourcesOpts {
	readonly limit?: number
}

export interface ScannerSourcesOutput {
	readonly clientAddress: string
	readonly requests: number
	readonly signatures: number
	/** The named tool, `''` when the source never sent a known scanner user agent. */
	readonly scanner: string
	readonly userAgent: string
	readonly lastSeen: DateTime.Utc
	/** The autonomous agent the source named, `''` for none; `scanner` alone could hide it. */
	readonly agent: string
	/** Distinct `Signature`s the source sent, `''` included; bounded by the probe catalog. */
	readonly probed: ReadonlyArray<string>
	/** Distinct traces refused with 401, 403 or 429. */
	readonly denied: number
	/** Seconds from the first refused request to the last 2xx or 3xx; read only when `denied` > 0. */
	readonly passedDenialSeconds: number
}

/** A 2xx or 3xx: the request got through, unlike a 404 that only missed. */
const servedOrRedirected = ($: ScannerAccessor) => $.HttpStatus.gte(200).and($.HttpStatus.lt(400))

const isDenied = ($: ScannerAccessor) =>
	CH.or($.HttpStatus.eq(401), $.HttpStatus.eq(403), $.HttpStatus.eq(429))

/** Autonomous agents first, so the row cap cannot drop one, then the busiest. No address, no row. */
export function scannerSourcesQuery(
	opts: ScannerSourcesOpts = {},
): CHQuery<ColumnDefs, ScannerSourcesOutput> {
	return from(Datasources.scannerRequests)
		.select(($) => ({
			clientAddress: $.ClientAddress,
			requests: CH.uniq($.TraceId),
			signatures: CH.uniqIf($.Signature, $.Signature.neq("")),
			scanner: CH.max_($.Scanner),
			// From the row holding that scanner name, so the pair belongs together.
			userAgent: CH.argMax($.UserAgent, $.Scanner),
			lastSeen: CH.max_($.Timestamp),
			agent: CH.compileTypedFnCall(
				"maxIf",
				T.string.schema,
				$.Scanner,
				CH.inList($.Scanner, AUTONOMOUS_SCANNER_NAMES),
			),
			probed: CH.groupUniqArray($.Signature),
			denied: CH.uniqIf($.TraceId, isDenied($)),
			passedDenialSeconds: CH.compileTypedFnCall(
				"dateDiff",
				T.int64.schema,
				CH.lit("second"),
				CH.compileFnCall<DateTime.Utc>("minIf", $.Timestamp, isDenied($)),
				CH.compileFnCall<DateTime.Utc>("maxIf", $.Timestamp, servedOrRedirected($)),
			),
		}))
		.where(($) => [...scannerWhere($), $.ClientAddress.neq("")])
		.groupBy("clientAddress")
		.orderBy(["agent", "desc"], ["requests", "desc"], ["clientAddress", "asc"])
		.limit(opts.limit ?? 20)
		.format("JSON")
}

/** Most buckets the timeline returns; the registry widens the bucket so a window fits. */
export const SCANNER_TIMELINE_MAX_BUCKETS = 2000

export interface ScannerTimelineOpts {
	readonly bucketSeconds?: number
}

export interface ScannerTimelineOutput {
	readonly bucket: DateTime.Utc
	readonly requests: number
	readonly answered: number
}

export function scannerTimelineQuery(
	opts: ScannerTimelineOpts = {},
): CHQuery<ColumnDefs, ScannerTimelineOutput> {
	const bucketSeconds = opts.bucketSeconds ?? 3600
	return from(Datasources.scannerRequests)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, bucketSeconds),
			requests: CH.uniq($.TraceId),
			answered: CH.uniqIf($.TraceId, answered($)),
		}))
		.where(scannerWhere)
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.limit(SCANNER_TIMELINE_MAX_BUCKETS)
		.format("JSON")
}

export interface RuntimeVersionsOutput {
	readonly service: string
	readonly environment: string
	readonly runtimeName: string
	readonly runtimeVersion: string
	readonly executableName: string
	readonly sdkLanguage: string
	readonly sdkName: string
	readonly sdkVersion: string
	readonly spans: number
	/** Start of the last hour the combination was seen in: the rollup is hourly. */
	readonly lastSeen: DateTime.Utc
}

/** Each service's runtime and SDK versions seen in the window, one row per combination. */
export function runtimeVersionsQuery(): CHQuery<ColumnDefs, RuntimeVersionsOutput> {
	return (
		from(Datasources.serviceRuntimesHourly)
			.select(($) => ({
				service: $.ServiceName,
				environment: $.DeploymentEnv,
				runtimeName: $.RuntimeName,
				runtimeVersion: $.RuntimeVersion,
				executableName: $.ExecutableName,
				sdkLanguage: $.SdkLanguage,
				sdkName: $.SdkName,
				sdkVersion: $.SdkVersion,
				spans: CH.sum($.SpanCount),
				lastSeen: CH.max_($.Hour),
			}))
			.where(($) => [
				$.OrgId.eq(orgIdParam),
				// Whole hours: the bucket holding `startTime` counts, so a service seen minutes in shows.
				$.Hour.gte(utcHourFloor("startTime")),
				$.Hour.lte(utcSecondsParam("endTime")),
			])
			.groupBy(
				"service",
				"environment",
				"runtimeName",
				"runtimeVersion",
				"executableName",
				"sdkLanguage",
				"sdkName",
				"sdkVersion",
			)
			// Every grouped column, so a window past the cap returns the same rows each time.
			.orderBy(
				["service", "asc"],
				["environment", "asc"],
				["runtimeName", "asc"],
				["runtimeVersion", "asc"],
				["executableName", "asc"],
				["sdkLanguage", "asc"],
				["sdkName", "asc"],
				["sdkVersion", "asc"],
			)
			.limit(1000)
			.format("JSON")
	)
}
