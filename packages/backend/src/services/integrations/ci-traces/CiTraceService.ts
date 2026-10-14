/**
 * Turns finished CI workflow runs and jobs into spans in the owning org's traces. Bound to the VCS
 * layer's `WorkflowEventSink`, so every org with the GitHub App installed gets CI traces with no
 * setup. Spans go through the ingest gateway with the org's public key, so they are metered and
 * routed like any other telemetry.
 */
import { type OrgId, UserId } from "@maple/domain/primitives"
import { Duration, Effect, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { Env } from "@maple/backend/platform/Env"
import {
	WorkflowEventSink,
	type WorkflowEventSinkApi,
} from "@maple/backend/services/integrations/vcs/WorkflowEventSink"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { isIngestRefusal, summarizeUpstreamBody } from "../upstream-body"
import { type OtlpTracesPayload, workflowJobToOtlp, workflowRunToOtlp } from "./otlp"

const INGEST_TIMEOUT = Duration.seconds(15)
const SYSTEM_USER_ID = Schema.decodeUnknownSync(UserId)("system-ci-traces")

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
	const ingestTracesUrl = `${env.MAPLE_INGEST_PUBLIC_URL.replace(/\/+$/, "")}/v1/traces`

	const post = (ingestKey: string, payload: OtlpTracesPayload) =>
		Effect.gen(function* () {
			const request = HttpClientRequest.post(ingestTracesUrl, {
				headers: { authorization: `Bearer ${ingestKey}`, "content-type": "application/json" },
			}).pipe(HttpClientRequest.bodyJsonUnsafe(payload))
			const response = yield* httpClient.execute(request).pipe(
				Effect.annotateSpans("peer.service", "ingest"),
				Effect.mapError(
					(error) =>
						new CiTraceIngestError({ message: `CI trace ingest failed: ${error.message}` }),
				),
			)
			if (response.status >= 300) {
				const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
				return yield* new CiTraceIngestError({
					message: `CI trace ingest returned ${response.status}: ${summarizeUpstreamBody(body, response.headers)}`,
					status: response.status,
				})
			}
		}).pipe(
			Effect.timeoutOrElse({
				duration: INGEST_TIMEOUT,
				orElse: () => Effect.fail(new CiTraceIngestError({ message: "CI trace ingest timed out" })),
			}),
			Effect.retry({
				schedule: Schedule.exponential(Duration.millis(250)),
				times: 2,
				while: isRetryable,
			}),
		)

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

	return {
		onWorkflowRun: (orgId, job) => emit(orgId, "run", workflowRunToOtlp(job)),
		onWorkflowJob: (orgId, job) => emit(orgId, "job", workflowJobToOtlp(job)),
	} satisfies WorkflowEventSinkApi
})

/** The `WorkflowEventSink` that writes CI spans. */
export const CiTraceSinkLive = Layer.effect(WorkflowEventSink, make).pipe(
	Layer.provide(FetchHttpClient.layer),
	Layer.provide(OrgIngestKeysService.layer),
)

/** Exposed for tests that bring their own HTTP client and ingest keys. */
export const CiTraceSinkWith = Layer.effect(WorkflowEventSink, make)
