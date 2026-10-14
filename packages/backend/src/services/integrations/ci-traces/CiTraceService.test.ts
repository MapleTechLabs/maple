import { afterEach, assert, describe, it } from "@effect/vitest"
import type { WorkflowJobJob, WorkflowRunJob } from "@maple/domain/http"
import { OrgId } from "@maple/domain/http"
import { ConfigProvider, Effect, Exit, Layer, Schema, Tracer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { WorkflowEventSink } from "@maple/backend/services/integrations/vcs/WorkflowEventSink"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { CiTraceSinkWith } from "./CiTraceService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const orgId = Schema.decodeUnknownSync(OrgId)("org_ci")

const makeConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			MAPLE_INGEST_PUBLIC_URL: "https://ingest.test/",
		}),
	)

const OtlpKeyValue = Schema.Struct({
	key: Schema.String,
	value: Schema.Struct({
		stringValue: Schema.optionalKey(Schema.String),
		intValue: Schema.optionalKey(Schema.String),
	}),
})
const OtlpRequest = Schema.Struct({
	resourceSpans: Schema.Array(
		Schema.Struct({
			resource: Schema.Struct({ attributes: Schema.Array(OtlpKeyValue) }),
			scopeSpans: Schema.Array(
				Schema.Struct({
					spans: Schema.Array(
						Schema.Struct({
							traceId: Schema.String,
							spanId: Schema.String,
							parentSpanId: Schema.String,
							name: Schema.String,
							startTimeUnixNano: Schema.String,
							endTimeUnixNano: Schema.String,
							attributes: Schema.Array(OtlpKeyValue),
							status: Schema.Struct({ code: Schema.Number, message: Schema.String }),
						}),
					),
				}),
			),
		}),
	),
})
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(OtlpRequest))
type OtlpRequest = typeof OtlpRequest.Type

interface IngestCall {
	readonly url: string
	readonly authorization: string | null
	readonly body: OtlpRequest
}

/** Records every ingest POST and answers with the next status in `statuses` (the last one repeats). */
const recordingFetch =
	(calls: Array<IngestCall>, statuses: ReadonlyArray<number> = [200]): typeof fetch =>
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
		const text = await new Response(init?.body ?? null).text()
		calls.push({
			url,
			authorization: new Headers(init?.headers).get("authorization"),
			body: decodeRequest(text),
		})
		const status = statuses[Math.min(calls.length - 1, statuses.length - 1)] ?? 200
		return new Response("{}", { status })
	}

const sinkLayer = (testDb: TestDb, fetchStub: typeof fetch) =>
	CiTraceSinkWith.pipe(
		Layer.provide(Layer.mergeAll(FetchHttpClient.layer, OrgIngestKeysService.layer)),
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchStub)),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig()),
	)

const run: WorkflowRunJob = {
	kind: "workflow-run",
	provider: "github",
	externalInstallationId: "42",
	externalRepoId: "7",
	repoFullName: "octo/repo",
	runId: "9001",
	runAttempt: 1,
	runNumber: 314,
	workflowName: "CI",
	workflowPath: ".github/workflows/ci.yml",
	triggerEvent: "pull_request",
	conclusion: "failure",
	headBranch: "feat/x",
	headSha: "abc",
	actorLogin: "octocat",
	pullRequestNumbers: [612],
	url: "https://github.com/octo/repo/actions/runs/9001",
	startedAtMs: 1_700_000_000_000,
	completedAtMs: 1_700_000_300_000,
}

const job: WorkflowJobJob = {
	kind: "workflow-job",
	provider: "github",
	externalInstallationId: "42",
	externalRepoId: "7",
	repoFullName: "octo/repo",
	runId: "9001",
	runAttempt: 1,
	jobId: "555",
	name: "test",
	workflowName: "CI",
	conclusion: "failure",
	headBranch: "feat/x",
	headSha: "abc",
	runnerName: "GitHub Actions 12",
	labels: ["ubuntu-latest"],
	url: "https://github.com/octo/repo/actions/runs/9001/job/555",
	queuedAtMs: 1_700_000_010_000,
	startedAtMs: 1_700_000_040_000,
	completedAtMs: 1_700_000_200_000,
	steps: [
		{
			number: 1,
			name: "Install",
			conclusion: "success",
			startedAtMs: 1_700_000_040_000,
			completedAtMs: 1_700_000_060_000,
		},
		{
			number: 2,
			name: "Test",
			conclusion: "failure",
			startedAtMs: 1_700_000_060_000,
			completedAtMs: 1_700_000_199_000,
		},
	],
}

const spansOf = (call: IngestCall) =>
	call.body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans))
const attr = (attributes: OtlpRequest["resourceSpans"][number]["resource"]["attributes"], key: string) => {
	const value = attributes.find((kv) => kv.key === key)?.value
	return value?.stringValue ?? value?.intValue
}

describe("CiTraceService", () => {
	it.live("writes a run and its job into one trace: run → job → steps", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<IngestCall> = []
		return Effect.gen(function* () {
			const sink = yield* WorkflowEventSink
			// Jobs finish before their run, so the job arrives first.
			yield* sink.onWorkflowJob(orgId, job)
			yield* sink.onWorkflowRun(orgId, run)

			assert.strictEqual(calls.length, 2)
			assert.strictEqual(calls[0]!.url, "https://ingest.test/v1/traces")
			assert.match(calls[0]!.authorization ?? "", /^Bearer maple_pk_/)
			assert.strictEqual(calls[0]!.authorization, calls[1]!.authorization)

			const [jobSpan, installStep, testStep] = spansOf(calls[0]!)
			const [runSpan] = spansOf(calls[1]!)
			assert.strictEqual(runSpan!.parentSpanId, "")
			assert.strictEqual(jobSpan!.traceId, runSpan!.traceId)
			assert.strictEqual(jobSpan!.parentSpanId, runSpan!.spanId)
			assert.strictEqual(installStep!.parentSpanId, jobSpan!.spanId)
			assert.strictEqual(testStep!.parentSpanId, jobSpan!.spanId)
			assert.match(runSpan!.traceId, /^[0-9a-f]{32}$/)
			assert.match(jobSpan!.spanId, /^[0-9a-f]{16}$/)

			assert.deepStrictEqual(
				[runSpan!.name, jobSpan!.name, installStep!.name, testStep!.name],
				["CI", "test", "Install", "Test"],
			)
			assert.strictEqual(jobSpan!.startTimeUnixNano, "1700000040000000000")
			assert.strictEqual(jobSpan!.endTimeUnixNano, "1700000200000000000")
			assert.strictEqual(attr(jobSpan!.attributes, "maple.cicd.queue_duration_ms"), "30000")
			assert.strictEqual(attr(runSpan!.attributes, "vcs.change.id"), "612")
			assert.strictEqual(
				attr(calls[1]!.body.resourceSpans[0]!.resource.attributes, "service.name"),
				"github-actions",
			)
			assert.strictEqual(
				attr(calls[1]!.body.resourceSpans[0]!.resource.attributes, "vcs.repository.name"),
				"repo",
			)
		}).pipe(Effect.provide(sinkLayer(testDb, recordingFetch(calls))))
	})

	it.live("marks failures as Error, passes as Ok, and cancelled runs as Unset", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<IngestCall> = []
		return Effect.gen(function* () {
			const sink = yield* WorkflowEventSink
			yield* sink.onWorkflowJob(orgId, job)
			yield* sink.onWorkflowRun(orgId, { ...run, conclusion: "cancelled" })
			const [jobSpan, installStep, testStep] = spansOf(calls[0]!)
			const [runSpan] = spansOf(calls[1]!)
			assert.deepStrictEqual(
				[jobSpan!.status.code, installStep!.status.code, testStep!.status.code, runSpan!.status.code],
				[2, 1, 2, 0],
			)
			assert.strictEqual(attr(runSpan!.attributes, "cicd.pipeline.result"), "cancellation")
		}).pipe(Effect.provide(sinkLayer(testDb, recordingFetch(calls))))
	})

	it.live("puts a re-run attempt in its own trace", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<IngestCall> = []
		return Effect.gen(function* () {
			const sink = yield* WorkflowEventSink
			yield* sink.onWorkflowRun(orgId, run)
			yield* sink.onWorkflowRun(orgId, { ...run, runAttempt: 2 })
			assert.notStrictEqual(spansOf(calls[0]!)[0]!.traceId, spansOf(calls[1]!)[0]!.traceId)
		}).pipe(Effect.provide(sinkLayer(testDb, recordingFetch(calls))))
	})

	it.live("retries a transient ingest failure", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<IngestCall> = []
		return Effect.gen(function* () {
			const sink = yield* WorkflowEventSink
			yield* sink.onWorkflowRun(orgId, run)
			assert.strictEqual(calls.length, 2)
		}).pipe(Effect.provide(sinkLayer(testDb, recordingFetch(calls, [503, 200]))))
	})

	it.live("gives up at once on a refused ingest key, without failing the webhook job", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<IngestCall> = []
		const spans: Array<Tracer.NativeSpan> = []
		const tracer = Tracer.make({
			span(options) {
				const span = new Tracer.NativeSpan(options)
				spans.push(span)
				return span
			},
		})
		return Effect.gen(function* () {
			const sink = yield* WorkflowEventSink
			yield* sink.onWorkflowRun(orgId, run).pipe(Effect.provideService(Tracer.Tracer, tracer))
			assert.strictEqual(calls.length, 1)
			// The webhook job succeeds, but the emit span itself records the lost write.
			const emit = spans.find((span) => span.name === "CiTraceService.emit")
			assert.strictEqual(emit?.status._tag, "Ended")
			if (emit?.status._tag !== "Ended") return
			assert.isTrue(Exit.isFailure(emit.status.exit))
			assert.strictEqual(emit.attributes.get("maple.cicd.outcome"), "ingest_failed")
		}).pipe(Effect.provide(sinkLayer(testDb, recordingFetch(calls, [402]))))
	})
})
