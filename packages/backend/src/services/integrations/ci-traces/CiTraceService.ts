/**
 * Turns finished CI workflow runs and jobs into spans in the owning org's traces, and a job's log
 * into log records on those spans. Bound to the VCS layer's `WorkflowEventSink`, so every org with
 * the GitHub App installed gets CI traces with no setup. Everything goes through the ingest gateway
 * with the org's public key, so it is metered and routed like any other telemetry.
 */
import { type OrgId, UserId } from "@maple/domain/primitives"
import { Duration, Effect, Layer, Schedule, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { Env } from "@maple/backend/platform/Env"
import {
	WorkflowEventSink,
	type WorkflowEventSinkApi,
} from "@maple/backend/services/integrations/vcs/WorkflowEventSink"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
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

	// Total by contract: a lost CI span is logged, never a failed webhook job. The failure is
	// swallowed outside the span, so the span itself still ends as Error.
	const emit = (orgId: OrgId, kind: "run" | "job", payload: OtlpTracesPayload) =>
		Effect.gen(function* () {
			const spanCount = payload.resourceSpans[0]?.scopeSpans[0]?.spans.length ?? 0
			yield* Effect.annotateCurrentSpan({ orgId, "maple.cicd.span_count": spanCount })
			const keys = yield* ingestKeys.getOrCreate(orgId, SYSTEM_USER_ID)
			yield* post(keys.publicKey, payload)
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
			const keys = yield* ingestKeys.getOrCreate(orgId, SYSTEM_USER_ID)
			const sent = yield* jobLogRecords(job, lines).pipe(
				Stream.grouped(LOG_BATCH_SIZE),
				Stream.runFoldEffect(
					() => 0,
					(count, batch) =>
						post(keys.publicKey, workflowJobLogsToOtlp(job, batch)).pipe(
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
		onWorkflowRun: (orgId, job) => emit(orgId, "run", workflowRunToOtlp(job)),
		onWorkflowJob: (orgId, job, annotations) => emit(orgId, "job", workflowJobToOtlp(job, annotations)),
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
