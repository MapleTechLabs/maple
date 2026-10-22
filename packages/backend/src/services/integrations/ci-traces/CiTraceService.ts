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
import { FetchHttpClient } from "effect/http"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { Database } from "@maple/backend/platform/DatabaseLive"
import {
	WorkflowEventSink,
	type WorkflowEventSinkApi,
} from "@maple/backend/services/integrations/vcs/WorkflowEventSink"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { isSourcePaused, stampedSourceId } from "@maple/backend/services/org/integration-sources"
import { isRefusal, makeIngestSender } from "@maple/backend/services/ingest/ingest-sender"
import { jobLogRecords, type OtlpLogsPayload, workflowJobLogsToOtlp } from "./logs"
import { type OtlpTracesPayload, workflowJobToOtlp, workflowRunToOtlp } from "./otlp"

/** Short, with two retries: a webhook job should not wait on a stalled gateway for long. */
const INGEST_TIMEOUT = Duration.seconds(15)
const SYSTEM_USER_ID = Schema.decodeUnknownSync(UserId)("system-ci-traces")
/** Log records per ingest request: about 1 MB of JSON, well under the gateway's body limit. */
const LOG_BATCH_SIZE = 1000
const UNLINKED = { stamped: undefined, paused: false } as const

const make = Effect.gen(function* () {
	const ingestKeys = yield* OrgIngestKeysService
	const database = yield* Database
	const ingest = yield* makeIngestSender

	// A refused key (billing, revoked) cannot succeed on retry; everything else gets two more tries.
	const post = (ingestKey: string, payload: OtlpTracesPayload | OtlpLogsPayload) => {
		const signal = "resourceLogs" in payload ? "logs" : "traces"
		return ingest
			.send({ signal, ingestKey, payload, label: `CI ${signal}`, timeout: INGEST_TIMEOUT })
			.pipe(
				Effect.retry({
					schedule: Schedule.exponential(Duration.millis(250)),
					times: 2,
					while: (error) => !isRefusal(error),
				}),
			)
	}

	// The installation's source: its `src_` id and whether it is paused. Never fails: without it the
	// spans go unstamped, and the gateway still drops a paused source's data.
	const installationSource = (
		orgId: OrgId,
		job: { readonly provider: string; readonly externalInstallationId: string },
	) =>
		job.provider !== "github"
			? Effect.succeed(UNLINKED)
			: database
					.execute((db) =>
						Effect.gen(function* () {
							const [installation] = yield* db.run(
								PG.from(VcsInstallations)
									.select("sourceId")
									.where(($) => [
										$.orgId.eq(orgId),
										$.provider.eq("github"),
										$.externalInstallationId.eq(job.externalInstallationId),
									])
									.limit(1),
							)
							const sourceId = installation?.sourceId ?? null
							return {
								stamped: stampedSourceId(sourceId),
								paused: yield* isSourcePaused(db, sourceId, yield* Clock.currentTimeMillis),
							}
						}),
					)
					.pipe(
						Effect.catch((error) =>
							Effect.logWarning("Installation source unavailable").pipe(
								Effect.annotateLogs({ orgId, error: error.message }),
								Effect.as(UNLINKED),
							),
						),
					)

	/**
	 * Posts with the org's public key. A 401 can be a key rotated in another graph while this one's
	 * memo holds the old key, so the memo entry is dropped and the post sent once more. A 403 is a
	 * key that may not send the signal, which a fresh read cannot fix.
	 */
	const postAs = (orgId: OrgId, payload: OtlpTracesPayload | OtlpLogsPayload) => {
		const send = ingestKeys
			.getOrCreate(orgId, SYSTEM_USER_ID)
			.pipe(Effect.flatMap((keys) => post(keys.publicKey, payload)))
		return send.pipe(
			Effect.catchTag("@maple/backend/ingest/IngestSendError", (error) =>
				error.status === 401
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
			const source = yield* installationSource(orgId, job)
			if (source.paused) {
				return yield* Effect.annotateCurrentSpan("maple.cicd.outcome", "source_paused")
			}
			const payload = toPayload(source.stamped)
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
			const source = yield* installationSource(orgId, job)
			if (source.paused) {
				return yield* Effect.annotateCurrentSpan("maple.cicd.outcome", "source_paused")
			}
			const sent = yield* jobLogRecords(job, lines).pipe(
				Stream.grouped(LOG_BATCH_SIZE),
				Stream.runFoldEffect(
					() => 0,
					(count, batch) =>
						postAs(orgId, workflowJobLogsToOtlp(job, batch, source.stamped)).pipe(
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
