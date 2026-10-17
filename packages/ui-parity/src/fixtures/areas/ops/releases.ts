import { DateTime, Effect, Schema } from "effect"
import {
	CommitSha,
	FingerprintHash,
	ReleaseDetailRequest,
	ReleaseDetailResponse,
	ReleasesListRequest,
	ReleasesListResponse,
	ServiceName,
} from "@maple/domain/http"
import { CH } from "@maple/query-engine"
import { Queries } from "@maple/query-engine/registry"
import { warehouseEndpoint } from "../../../backend/endpoints/run.ts"
import type { FixtureWarehouse } from "../../../backend/warehouse.ts"
import type { EndpointHandler } from "../../dataset.ts"

/** `releasesList` / `releaseDetail` of `HttpQueryEngineLive`: same registry queries and row shaping. */

const decodeServiceName = Schema.decodeUnknownSync(ServiceName)
const decodeCommitSha = Schema.decodeUnknownSync(CommitSha)
const decodeFingerprintHash = Schema.decodeUnknownSync(FingerprintHash)

const toReleaseRow = (row: CH.ReleasesListOutput) => {
	const spanCount = row.spanCount
	return {
		serviceName: decodeServiceName(row.serviceName),
		environment: row.environment,
		commitSha: decodeCommitSha(row.commitSha),
		firstSeen: DateTime.formatIso(row.firstSeen),
		spanCount,
		errorCount: row.errorCount,
		p50LatencyMs: row.p50LatencyMs,
		p95LatencyMs: row.p95LatencyMs,
		p99LatencyMs: row.p99LatencyMs,
		apdexScore:
			spanCount > 0
				? Math.round(
						((row.apdexSatisfiedCount + row.apdexToleratingCount * 0.5) / spanCount) * 10_000,
					) / 10_000
				: 0,
	}
}

const toReleaseTimelinePoint = (row: CH.ReleasesTimelineOutput) => ({
	bucket: DateTime.formatIso(row.bucket),
	serviceName: decodeServiceName(row.serviceName),
	commitSha: decodeCommitSha(row.commitSha),
	count: row.count,
})

export const releaseEndpoints = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => ({
	"queryEngine.releasesList": warehouseEndpoint(
		warehouse,
		ReleasesListRequest,
		ReleasesListResponse,
		(payload, { runQuery }) =>
			Effect.map(
				Effect.all([
					runQuery(Queries.releasesList, payload),
					runQuery(Queries.releasesTimeline, payload),
				]),
				([rows, timeline]) =>
					new ReleasesListResponse({
						releases: rows.map(toReleaseRow),
						timeline: timeline.map(toReleaseTimelinePoint),
						truncated: rows.length >= CH.RELEASES_LIST_CAP,
					}),
			),
	),
	"queryEngine.releaseDetail": warehouseEndpoint(
		warehouse,
		ReleaseDetailRequest,
		ReleaseDetailResponse,
		(payload, { runQuery, tenant }) =>
			Effect.gen(function* () {
				const [versions, timeline, timeseries, baselineTimeseries, fingerprints] = yield* Effect.all([
					runQuery(Queries.releaseVersions, payload),
					runQuery(Queries.releaseTimeline, payload),
					warehouse.executeQuery(tenant, payload.timeseries),
					warehouse.executeQuery(tenant, payload.baselineTimeseries),
					runQuery(Queries.releaseErrorFingerprints, payload),
				])
				return new ReleaseDetailResponse({
					versions: versions.map(toReleaseRow),
					timeline: timeline.map(toReleaseTimelinePoint),
					timeseries,
					baselineTimeseries,
					errorFingerprints: fingerprints.map((row) => ({
						fingerprintHash: decodeFingerprintHash(row.fingerprintHash),
						count: row.count,
						firstSeen: DateTime.formatIso(row.firstSeen),
					})),
				})
			}),
	),
})
