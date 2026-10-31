// The Security Center's telemetry tabs.
// - Exposure: `scanner_requests`, Server spans that probe for secrets, source control, debug
//   endpoints and known exploits, or come from a named scanning tool.
// - Runtimes: `service_runtimes_hourly`, the runtime and telemetry SDK each service reports.

import * as CH from "@maple-dev/effect-orm/expr"
import type { DateTime } from "effect"
import { param, from } from "@maple-dev/effect-orm/clickhouse"
import type { CHQuery, ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import { CRITICAL_PROBE_SIGNATURES } from "@maple/domain/security-telemetry"
import { ScannerRequests, ServiceRuntimesHourly, orgIdParam, utcSecondsParam } from "../tables"
import { utcHourFloor } from "./query-helpers"

type ScannerAccessor = ColumnAccessor<typeof ScannerRequests.columns>

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

/** Requests per probe signature and service. Bounded: a few dozen signatures per service. */
export function scannerSignaturesQuery(): CHQuery<any, ScannerSignaturesOutput, any> {
	return from(ScannerRequests)
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
		.limit(500)
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
export function scannerExposedQuery(opts: ScannerExposedOpts = {}): CHQuery<any, ScannerExposedOutput, any> {
	return from(ScannerRequests)
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
				CRITICAL_PROBE_SIGNATURES.map((signature) => signature.token),
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
}

/** The busiest sources. Spans without a client address are left out. */
export function scannerSourcesQuery(opts: ScannerSourcesOpts = {}): CHQuery<any, ScannerSourcesOutput, any> {
	return from(ScannerRequests)
		.select(($) => ({
			clientAddress: $.ClientAddress,
			requests: CH.uniq($.TraceId),
			signatures: CH.uniqIf($.Signature, $.Signature.neq("")),
			scanner: CH.max_($.Scanner),
			userAgent: CH.any_($.UserAgent),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(($) => [...scannerWhere($), $.ClientAddress.neq("")])
		.groupBy("clientAddress")
		.orderBy(["requests", "desc"])
		.limit(opts.limit ?? 20)
		.format("JSON")
}

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
): CHQuery<any, ScannerTimelineOutput, any> {
	const bucketSeconds = opts.bucketSeconds ?? 3600
	return from(ScannerRequests)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, bucketSeconds),
			requests: CH.uniq($.TraceId),
			answered: CH.uniqIf($.TraceId, answered($)),
		}))
		.where(scannerWhere)
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.limit(2000)
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
export function runtimeVersionsQuery(): CHQuery<any, RuntimeVersionsOutput, any> {
	return from(ServiceRuntimesHourly)
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
		.orderBy(["service", "asc"])
		.limit(1000)
		.format("JSON")
}
