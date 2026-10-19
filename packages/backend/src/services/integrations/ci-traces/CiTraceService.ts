/**
 * Turns finished CI workflow runs and jobs into spans in the owning org's traces, and a job's log
 * into log records on those spans. Bound to the VCS layer's `WorkflowEventSink`, so every org with
 * the GitHub App installed gets CI traces with no setup. Everything goes through the ingest gateway
 * with the org's public key, so it is metered and routed like any other telemetry.
 */
import type { WorkflowJobJob, WorkflowRunJob } from "@maple/domain/http"
import { type OrgId, UserId } from "@maple/domain/primitives"
import { VcsInstallations } from "@maple/db/tables"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Clock, Duration, Effect, Layer, Schedule, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import {
	WorkflowEventSink,
	type WorkflowEventSinkApi,
} from "@maple/backend/services/integrations/vcs/WorkflowEventSink"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import {
	ensureIntegrationSource,
	integrationSourceName,
	stampableSourceId,
} from "@maple/backend/services/org/integration-sources"
import { isIngestRefusal, summarizeUpstreamBody } from "../upstream-body"
import { jobLogRecords, type OtlpLogsPayload, workflowJobLogsToOtlp } from "./logs"
import { type OtlpTracesPayload, workflowJobToOtlp, workflowRunToOtlp } from "./otlp"

const INGEST_TIMEOUT = Duration.seconds(15)
const SYSTEM_USER_ID = Schema.decodeUnknownSync(UserId)("system-ci-traces")
/** Log records per ingest request: about 1 MB of JSON, well under the gateway's body limit. */
const LOG_BATCH_SIZE = 1000

export class CiTraceIngestError extends Schema.TaggedError<CiTraceIngestError>()(
	"@maple/backend/integrations/CiTraceIngestError",
	{
		message: Schema.String,
		status: Schema.optionalKey(Schema.Number),
	},
) {}

/** A refused key (billing, revoked) cannot succeed on retry; everything else is worth two more tries. */
const isRetryable = (error: CiTraceIngestError) =>
	error.status === undefined || !isIngestRefusal(error.status)

const make = Effect.gen(function* () {
	const env = yield* Env
	const httpClient = yield* HttpClient.HttpClient
	const ingestKeys = yield* OrgIngestKeysService
	const database = yield* Database
	const ingestBaseUrl = env.MAPLE_INGEST_PUBLIC_URL.replace(/\/+$/, "")

	const post = (ingestKey: string, payload: OtlpTracesPayload | OtlpLogsPayload) => {
		const signal = "resourceLogs" in payload ? "logs" : "traces"
		return Effect.gen(function* () {
			const request = HttpClientRequest.post(`${ingestBaseUrl}/v1/${signal}`, {
				headers: { authorization: `Bearer ${ingestKey}`, "content-type": "application/json" },
			}).pipe(HttpClientRequest.bodyJsonUnsafe(payload))
			const response = yield* httpClient.execute(request).pipe(
				Effect.annotateSpans("peer.service", "ingest"),
				Effect.mapError(
					(error) =>
						new CiTraceIngestError({ message: `CI ${signal} ingest failed: ${error.message}` }),
				),
			)
			if (response.status >= 300) {
				const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
				return yield* new CiTraceIngestError({
					message: `CI ${signal} ingest returned ${response.status}: ${summarizeUpstreamBody(body, response.headers)}`,
					status: response.status,
				})
			}
		}).pipe(
			Effect.timeoutOrElse({
				duration: INGEST_TIMEOUT,
				orElse: () =>
					Effect.fail(new CiTraceIngestError({ message: `CI ${signal} ingest timed out` })),
			}),
			Effect.retry({
				schedule: Schedule.exponential(Duration.millis(250)),
				times: 2,
				while: isRetryable,
			}),
		)
	}

	// The installation's pull source as its `src_` id. Never fails: without it the spans go unstamped.
	const resolveSourceId = (
		orgId: OrgId,
		job: { readonly provider: string; readonly externalInstallationId: string },
	) =>
		stampableSourceId(
			Effect.gen(function* () {
				if (job.provider !== "github") return undefined
				const now = yield* Clock.currentTimeMillis
				return yield* database.execute((db) =>
					Effect.gen(function* () {
						const [installation] = yield* db.run(
							PG.from(VcsInstallations)
								.select("id", "accountLogin")
								.where(($) => [
									$.orgId.eq(orgId),
									$.provider.eq("github"),
									$.externalInstallationId.eq(job.externalInstallationId),
								])
								.limit(1),
						)
						if (installation === undefined) return undefined
						return yield* ensureIntegrationSource(
							db,
							orgId,
							{
								platform: "github",
								integrationId: installation.id,
								name: integrationSourceName.github(installation),
							},
							now,
						)
					}),
				)
			}),
			{ orgId, platform: "github" },
		)

	/**
	 * Posts with the org's public key. A 401 or 403 can be a key rotated in another graph while this
	 * one's memo holds the old key, so the memo entry is dropped and the post sent once more.
	 */
	const postAs = (orgId: OrgId, payload: OtlpTracesPayload | OtlpLogsPayload) => {
		const send = ingestKeys
			.getOrCreate(orgId, SYSTEM_USER_ID)
			.pipe(Effect.flatMap((keys) => post(keys.publicKey, payload)))
		return send.pipe(
			Effect.catchTag("@maple/backend/integrations/CiTraceIngestError", (error) =>
				error.status === 401 || error.status === 403
					? ingestKeys.forget(orgId).pipe(Effect.andThen(send))
					: Effect.fail(error),
			),
		)
	}

	// Total by contract: a lost CI span is logged, never a failed webhook job. The failure is
	// swallowed outside the span, so the span itself still ends as Error.
	const emit = (
		orgId: OrgId,
		kind: "run" | "job",
		job: WorkflowRunJob | WorkflowJobJob,
		toPayload: (sourceId: string | undefined) => OtlpTracesPayload,
	) =>
		Effect.gen(function* () {
			const payload = toPayload(yield* resolveSourceId(orgId, job))
			const spanCount = payload.resourceSpans[0]?.scopeSpans[0]?.spans.length ?? 0
			yield* Effect.annotateCurrentSpan({ orgId, "maple.cicd.span_count": spanCount })
			yield* postAs(orgId, payload)
		}).pipe(
			Effect.tapCause((cause) =>
				Effect.annotateCurrentSpan({
					"maple.cicd.outcome": "ingest_failed",
					"maple.cicd.failure": summarizeCause(cause),
				}),
			),
			Effect.withSpan("CiTraceService.emit", { attributes: { "maple.cicd.kind": kind } }),
			Effect.catchCause((cause) =>
				Effect.logWarning("[CI traces] failed to ingest CI spans").pipe(
					Effect.annotateLogs({ orgId, kind, cause: summarizeCause(cause) }),
				),
			),
		)

	// Total like `emit`. Batches go out as the log downloads; a failure partway keeps what was sent.
	const emitLog = <E>(
		orgId: OrgId,
		job: Parameters<typeof jobLogRecords>[0],
		lines: Stream.Stream<string, E>,
	) =>
		Effect.gen(function* () {
			const sourceId = yield* resolveSourceId(orgId, job)
			const sent = yield* jobLogRecords(job, lines).pipe(
				Stream.grouped(LOG_BATCH_SIZE),
				Stream.runFoldEffect(
					() => 0,
					(count, batch) =>
						postAs(orgId, workflowJobLogsToOtlp(job, batch, sourceId)).pipe(
							Effect.as(count + batch.length),
						),
				),
			)
			yield* Effect.annotateCurrentSpan({ orgId, "maple.cicd.log_record_count": sent })
		}).pipe(
			Effect.tapCause((cause) =>
				Effect.annotateCurrentSpan({
					"maple.cicd.outcome": "log_failed",
					"maple.cicd.failure": summarizeCause(cause),
				}),
			),
			Effect.withSpan("CiTraceService.emitLog", {
				attributes: { "cicd.pipeline.task.run.id": job.jobId },
			}),
			Effect.catchCause((cause) =>
				Effect.logWarning("[CI traces] failed to ingest a CI job's log").pipe(
					Effect.annotateLogs({ orgId, jobId: job.jobId, cause: summarizeCause(cause) }),
				),
			),
		)

	return {
		onWorkflowRun: (orgId, job) =>
			emit(orgId, "run", job, (sourceId) => workflowRunToOtlp(job, sourceId)),
		onWorkflowJob: (orgId, job, annotations) =>
			emit(orgId, "job", job, (sourceId) => workflowJobToOtlp(job, annotations, sourceId)),
		onWorkflowJobLog: emitLog,
	} satisfies WorkflowEventSinkApi
})

/** The `WorkflowEventSink` that writes CI spans. */
export const CiTraceSinkLive = Layer.effect(WorkflowEventSink, make).pipe(
	Layer.provide(FetchHttpClient.layer),
	Layer.provide(OrgIngestKeysService.layer),
)

/** Exposed for tests that bring their own HTTP client and ingest keys. */
export const CiTraceSinkWith = Layer.effect(WorkflowEventSink, make)
