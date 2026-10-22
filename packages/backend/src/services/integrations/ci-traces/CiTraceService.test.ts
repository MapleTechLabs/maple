import { afterEach, assert, describe, it } from "@effect/vitest"
import type { WorkflowJobAnnotation, WorkflowJobJob, WorkflowRunJob } from "@maple/domain/http"
import { OrgId, UserId } from "@maple/domain/http"
import type { OrgIngestKeyRow } from "@maple/db/tables"
import { makeExpiringStore } from "@maple/backend/platform/expiring-store"
import { SharedIngestKeysMemo } from "@maple/backend/services/org/shared-ingest-keys-memo"
import { ConfigProvider, Effect, Exit, Layer, Schema, Stream, Tracer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	insertTestSource,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { publicSourceId } from "@maple/backend/services/org/integration-sources"
import { SourceId } from "@maple/domain/primitives"
import { WorkflowEventSink } from "@maple/backend/services/integrations/vcs/WorkflowEventSink"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { CiTraceSinkWith } from "./CiTraceService"
import { MAX_JOB_LOG_CHARS } from "./logs"

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
							kind: Schema.Number,
							startTimeUnixNano: Schema.String,
							endTimeUnixNano: Schema.String,
							attributes: Schema.Array(OtlpKeyValue),
							status: Schema.Struct({ code: Schema.Number, message: Schema.String }),
							events: Schema.optionalKey(
								Schema.Array(
									Schema.Struct({
										name: Schema.String,
										attributes: Schema.Array(OtlpKeyValue),
									}),
								),
							),
						}),
					),
				}),
			),
		}),
	),
})
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(OtlpRequest))
type OtlpRequest = typeof OtlpRequest.Type

const OtlpLogsRequest = Schema.Struct({
	resourceLogs: Schema.Array(
		Schema.Struct({
			resource: Schema.Struct({ attributes: Schema.Array(OtlpKeyValue) }),
			scopeLogs: Schema.Array(
				Schema.Struct({
					logRecords: Schema.Array(
						Schema.Struct({
							timeUnixNano: Schema.String,
							severityText: Schema.String,
							body: Schema.Struct({ stringValue: Schema.String }),
							attributes: Schema.Array(OtlpKeyValue),
							traceId: Schema.String,
							spanId: Schema.String,
						}),
					),
				}),
			),
		}),
	),
})
const decodeLogsRequest = Schema.decodeUnknownSync(Schema.fromJsonString(OtlpLogsRequest))
type OtlpLogsRequest = typeof OtlpLogsRequest.Type

interface IngestCall {
	readonly url: string
	readonly authorization: string | null
	readonly body: OtlpRequest
}

/**
 * Records every ingest POST and answers with the next status in `statuses` (the last one repeats).
 * Log batches go to `logCalls` instead of `calls`.
 */
const recordingFetch =
	(
		calls: Array<IngestCall>,
		statuses: ReadonlyArray<number> = [200],
		logCalls: Array<OtlpLogsRequest> = [],
	): typeof fetch =>
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
		const text = await new Response(init?.body ?? null).text()
		if (url.endsWith("/v1/logs")) {
			logCalls.push(decodeLogsRequest(text))
			return new Response("{}", { status: 200 })
		}
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

const keysLayer = (testDb: TestDb) =>
	OrgIngestKeysService.layer.pipe(
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

const recordsOf = (calls: ReadonlyArray<OtlpLogsRequest>) =>
	calls.flatMap((call) => call.resourceLogs.flatMap((rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords)))

/** Stamps a log line at `ms` after the job started, the way the runner does. */
const stamped = (ms: number, text: string) =>
	`${new Date(job.startedAtMs + ms).toISOString().replace("Z", "0000Z")} ${text}`

const spansOf = (call: IngestCall) =>
	call.body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans))
const attr = (attributes: OtlpRequest["resourceSpans"][number]["resource"]["attributes"], key: string) => {
	const value = attributes.find((kv) => kv.key === key)?.value
	return value?.stringValue ?? value?.intValue
}

// Installation 42 of `org_ci` with its source, as VcsRepository.upsertInstallation writes it.
const seedInstallation = (testDb: TestDb, options: { readonly paused?: boolean } = {}) =>
	Effect.promise(async () => {
		const sourceId = await insertTestSource(testDb, { orgId: "org_ci", platform: "github", name: "GitHub octo" })
		if (options.paused === true) {
			await executeSql(testDb, "UPDATE sources SET paused_at = now() WHERE id = $1", [sourceId])
		}
		await executeSql(
			testDb,
			`INSERT INTO vcs_installations (id, org_id, provider, external_installation_id, account_login,
				account_type, external_account_id, installed_by_user_id, created_at, updated_at, source_id)
			VALUES ('00000000-0000-4000-8000-000000000042', 'org_ci', 'github', '42', 'octo', 'Organization',
				'1', 'user_1', now(), now(), $1)`,
			[sourceId],
		)
	})

describe("CiTraceService", () => {
	it.live("stamps the installation's pull source on CI spans and logs", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<IngestCall> = []
		const logCalls: Array<OtlpLogsRequest> = []
		return Effect.gen(function* () {
			yield* seedInstallation(testDb)
			const sink = yield* WorkflowEventSink
			yield* sink.onWorkflowRun(orgId, run)
			yield* sink.onWorkflowJobLog(orgId, job, Stream.fromIterable([stamped(123, "hello")]))

			const source = yield* Effect.promise(() =>
				queryFirstRow<{ id: string; name: string }>(
					testDb,
					"SELECT id, name FROM sources WHERE platform = 'github'",
				),
			)
			assert.strictEqual(source!.name, "GitHub octo")
			const expected = publicSourceId(Schema.decodeUnknownSync(SourceId)(source!.id))
			assert.strictEqual(
				attr(calls[0]!.body.resourceSpans[0]!.resource.attributes, "maple_source_id"),
				expected,
			)
			assert.strictEqual(
				logCalls[0]!.resourceLogs[0]!.resource.attributes.find((kv) => kv.key === "maple_source_id")
					?.value.stringValue,
				expected,
			)
		}).pipe(Effect.provide(sinkLayer(testDb, recordingFetch(calls, [200], logCalls))))
	})

	it.live("drops CI spans and logs while the installation's source is paused", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<IngestCall> = []
		const logCalls: Array<OtlpLogsRequest> = []
		return Effect.gen(function* () {
			yield* seedInstallation(testDb, { paused: true })
			const sink = yield* WorkflowEventSink
			yield* sink.onWorkflowRun(orgId, run)
			yield* sink.onWorkflowJobLog(orgId, job, Stream.fromIterable([stamped(123, "hello")]))
			assert.deepStrictEqual([calls.length, logCalls.length], [0, 0])
		}).pipe(Effect.provide(sinkLayer(testDb, recordingFetch(calls, [200], logCalls))))
	})

	it.live("sends CI spans without a source when the installation is unknown", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<IngestCall> = []
		return Effect.gen(function* () {
			const sink = yield* WorkflowEventSink
			yield* sink.onWorkflowRun(orgId, run)
			assert.lengthOf(calls, 1)
			assert.isUndefined(attr(calls[0]!.body.resourceSpans[0]!.resource.attributes, "maple_source_id"))
		}).pipe(Effect.provide(sinkLayer(testDb, recordingFetch(calls))))
	})

	it.live("writes a run and its job into one trace: run → job → steps", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<IngestCall> = []
		return Effect.gen(function* () {
			const sink = yield* WorkflowEventSink
			// Jobs finish before their run, so the job arrives first.
			yield* sink.onWorkflowJob(orgId, job, [])
			yield* sink.onWorkflowRun(orgId, run)

			assert.strictEqual(calls.length, 2)
			assert.strictEqual(calls[0]!.url, "https://ingest.test/v1/traces")
			assert.match(calls[0]!.authorization ?? "", /^Bearer maple_pk_/)
			assert.strictEqual(calls[0]!.authorization, calls[1]!.authorization)

			const [jobSpan, queueSpan, installStep, testStep] = spansOf(calls[0]!)
			const [runSpan] = spansOf(calls[1]!)
			assert.strictEqual(runSpan!.parentSpanId, "")
			assert.strictEqual(queueSpan!.parentSpanId, jobSpan!.spanId)
			assert.strictEqual(jobSpan!.traceId, runSpan!.traceId)
			assert.strictEqual(jobSpan!.parentSpanId, runSpan!.spanId)
			assert.strictEqual(installStep!.parentSpanId, jobSpan!.spanId)
			assert.strictEqual(testStep!.parentSpanId, jobSpan!.spanId)
			assert.match(runSpan!.traceId, /^[0-9a-f]{32}$/)
			assert.match(jobSpan!.spanId, /^[0-9a-f]{16}$/)

			assert.deepStrictEqual(
				[runSpan!.name, jobSpan!.name, queueSpan!.name, installStep!.name, testStep!.name],
				["RUN CI", "test", "Waiting for a runner", "Install", "Test"],
			)
			// The job span covers its 30s wait for a runner, which the queue span shows.
			assert.strictEqual(jobSpan!.startTimeUnixNano, "1700000010000000000")
			assert.strictEqual(jobSpan!.endTimeUnixNano, "1700000200000000000")
			assert.strictEqual(queueSpan!.startTimeUnixNano, "1700000010000000000")
			assert.strictEqual(queueSpan!.endTimeUnixNano, "1700000040000000000")
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
			yield* sink.onWorkflowJob(orgId, job, [])
			yield* sink.onWorkflowRun(orgId, { ...run, conclusion: "cancelled" })
			const [jobSpan, , installStep, testStep] = spansOf(calls[0]!)
			const [runSpan] = spansOf(calls[1]!)
			assert.deepStrictEqual(
				[jobSpan!.status.code, installStep!.status.code, testStep!.status.code, runSpan!.status.code],
				[2, 1, 2, 0],
			)
			assert.strictEqual(attr(runSpan!.attributes, "cicd.pipeline.result"), "cancellation")
		}).pipe(Effect.provide(sinkLayer(testDb, recordingFetch(calls))))
	})

	it.live("says why a job failed: the specific annotation, not the runner's exit code", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<IngestCall> = []
		const annotations: ReadonlyArray<WorkflowJobAnnotation> = [
			{
				level: "failure",
				message: "Process completed with exit code 1.",
				title: null,
				path: ".github",
				startLine: null,
			},
			{ level: "warning", message: "Node 16 is deprecated", title: null, path: null, startLine: null },
			{
				level: "failure",
				message: "expected 2 to be 3",
				title: "adds",
				path: "src/math.test.ts",
				startLine: 12,
			},
		]
		return Effect.gen(function* () {
			const sink = yield* WorkflowEventSink
			yield* sink.onWorkflowJob(orgId, job, annotations)
			const [jobSpan] = spansOf(calls[0]!)
			assert.strictEqual(jobSpan!.status.code, 2)
			assert.strictEqual(jobSpan!.status.message, "src/math.test.ts:12: adds: expected 2 to be 3")
			assert.strictEqual(
				attr(jobSpan!.attributes, "maple.cicd.failure.reason"),
				"src/math.test.ts:12: adds: expected 2 to be 3",
			)
			assert.deepStrictEqual(
				(jobSpan!.events ?? []).map((event) =>
					attr(event.attributes, "maple.cicd.annotation.message"),
				),
				// Failures first, then the rest.
				[annotations[0]!.message, annotations[2]!.message, annotations[1]!.message],
			)
		}).pipe(Effect.provide(sinkLayer(testDb, recordingFetch(calls))))
	})

	it.live("prefers a failure that says where over a bare summary", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<IngestCall> = []
		return Effect.gen(function* () {
			const sink = yield* WorkflowEventSink
			yield* sink.onWorkflowJob(orgId, job, [
				{ level: "failure", message: "Tests failed", title: null, path: null, startLine: null },
				{
					level: "failure",
					message: "expected 2 to be 3",
					title: null,
					path: "src/a.test.ts",
					startLine: 4,
				},
			])
			assert.strictEqual(spansOf(calls[0]!)[0]!.status.message, "src/a.test.ts:4: expected 2 to be 3")
		}).pipe(Effect.provide(sinkLayer(testDb, recordingFetch(calls))))
	})

	it.live("finds the repository URL of a repository named actions", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<IngestCall> = []
		return Effect.gen(function* () {
			const sink = yield* WorkflowEventSink
			yield* sink.onWorkflowRun(orgId, {
				...run,
				repoFullName: "octo/actions",
				url: "https://github.com/octo/actions/actions/runs/9001",
			})
			assert.strictEqual(
				attr(calls[0]!.body.resourceSpans[0]!.resource.attributes, "vcs.repository.url.full"),
				"https://github.com/octo/actions",
			)
		}).pipe(Effect.provide(sinkLayer(testDb, recordingFetch(calls))))
	})

	it.live("names a step without the commit its action is pinned to", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<IngestCall> = []
		const pinned = "Run jdx/mise-action@2d8d4cafcbd33be2ea37d2b6f5ad595363d1f1ca"
		return Effect.gen(function* () {
			const sink = yield* WorkflowEventSink
			yield* sink.onWorkflowJob(orgId, { ...job, steps: [{ ...job.steps[0]!, name: pinned }] }, [])
			const step = spansOf(calls[0]!).at(-1)!
			assert.strictEqual(step.name, "Run jdx/mise-action")
			assert.strictEqual(attr(step.attributes, "maple.cicd.step.name"), pinned)
		}).pipe(Effect.provide(sinkLayer(testDb, recordingFetch(calls))))
	})

	it.live("adds no queue span for a job that got a runner at once", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<IngestCall> = []
		return Effect.gen(function* () {
			const sink = yield* WorkflowEventSink
			yield* sink.onWorkflowJob(orgId, { ...job, queuedAtMs: job.startedAtMs }, [])
			const spans = spansOf(calls[0]!)
			assert.strictEqual(spans.length, 1 + job.steps.length)
			assert.strictEqual(spans[0]!.startTimeUnixNano, "1700000040000000000")
		}).pipe(Effect.provide(sinkLayer(testDb, recordingFetch(calls))))
	})

	it.live("follows the CI/CD semantic conventions for runs and tasks", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<IngestCall> = []
		return Effect.gen(function* () {
			const sink = yield* WorkflowEventSink
			yield* sink.onWorkflowJob(orgId, job, [])
			yield* sink.onWorkflowRun(orgId, run)
			const [jobSpan, , installStep, testStep] = spansOf(calls[0]!)
			const [runSpan] = spansOf(calls[1]!)

			// A run is a SERVER span named `{action} {pipeline}`; tasks are INTERNAL.
			assert.deepStrictEqual([runSpan!.kind, jobSpan!.kind, testStep!.kind], [2, 1, 1])
			assert.strictEqual(attr(runSpan!.attributes, "cicd.pipeline.action.name"), "RUN")
			// `error.type` on a failed run or task, never on one that passed.
			assert.deepStrictEqual(
				[runSpan!, jobSpan!, installStep!, testStep!].map((span) =>
					attr(span.attributes, "error.type"),
				),
				["failure", "failure", undefined, "failure"],
			)
			// A step is a task of its own: its name, an id unique in the run, a link to its log line.
			assert.strictEqual(attr(testStep!.attributes, "cicd.pipeline.task.name"), "Test")
			assert.strictEqual(attr(testStep!.attributes, "cicd.pipeline.task.run.id"), "555.2")
			assert.strictEqual(
				attr(testStep!.attributes, "cicd.pipeline.task.run.url.full"),
				"https://github.com/octo/repo/actions/runs/9001/job/555#step:2:1",
			)
			assert.strictEqual(attr(jobSpan!.attributes, "cicd.pipeline.task.run.id"), "555")
			assert.strictEqual(
				attr(calls[0]!.body.resourceSpans[0]!.resource.attributes, "vcs.repository.url.full"),
				"https://github.com/octo/repo",
			)
		}).pipe(Effect.provide(sinkLayer(testDb, recordingFetch(calls))))
	})

	it.live("gives a job that never got a runner no wait span and no length", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<IngestCall> = []
		return Effect.gen(function* () {
			const sink = yield* WorkflowEventSink
			// How the provider maps a job skipped before it started: it starts when it completed.
			yield* sink.onWorkflowJob(
				orgId,
				{ ...job, conclusion: "skipped", startedAtMs: job.completedAtMs, steps: [] },
				[],
			)
			const [jobSpan, ...rest] = spansOf(calls[0]!)
			assert.lengthOf(rest, 0)
			assert.strictEqual(jobSpan!.startTimeUnixNano, jobSpan!.endTimeUnixNano)
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

	it.live("after a key rotation elsewhere, drops the stale memoized key and sends once more", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<IngestCall> = []
		return Effect.gen(function* () {
			// The isolate memo the queue consumer shares across batches.
			const memo = Layer.succeed(SharedIngestKeysMemo, yield* makeExpiringStore<OrgIngestKeyRow>())
			const batch = sinkLayer(testDb, recordingFetch(calls, [200, 401, 200])).pipe(Layer.provide(memo))
			const emitJob = WorkflowEventSink.use((sink) => sink.onWorkflowJob(orgId, job, []))
			yield* emitJob.pipe(Effect.provide(batch))
			// The rotation runs in another graph with its own memo, as the HTTP route does.
			const rotated = yield* OrgIngestKeysService.use((keys) =>
				keys.rerollPublic(orgId, Schema.decodeUnknownSync(UserId)("user_rotates")),
			).pipe(Effect.provide(keysLayer(testDb)))
			yield* emitJob.pipe(Effect.provide(batch))
			assert.deepStrictEqual(
				calls.map((call) => call.authorization),
				[calls[0]!.authorization, calls[0]!.authorization, `Bearer ${rotated.publicKey}`],
			)
			assert.notStrictEqual(rotated.publicKey, calls[0]!.authorization?.slice("Bearer ".length))
		})
	})

	it.live("does not re-read the key or resend after a 403", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<IngestCall> = []
		return Effect.gen(function* () {
			yield* WorkflowEventSink.use((sink) => sink.onWorkflowJob(orgId, job, []))
			assert.strictEqual(calls.length, 1)
		}).pipe(Effect.provide(sinkLayer(testDb, recordingFetch(calls, [403, 200]))))
	})

	it.live("writes a job's log as records on the step span that was running at each line", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Array<IngestCall> = []
		const logCalls: Array<OtlpLogsRequest> = []
		const lines = [
			// The runner writes before the first step starts; that line belongs to the job.
			`\uFEFF${stamped(-123, "Current runner version: '2.320.0'")}`,
			stamped(123, "##[group]Run bun install"),
			stamped(500, "##[endgroup]"),
			// The second step starts 20s in.
			stamped(30_000, "\u001b[31mFAIL\u001b[0m src/math.test.ts"),
			"  expected 2 to be 3",
			stamped(31_000, "##[error]Process completed with exit code 1."),
			stamped(31_500, ""),
		]
		return Effect.gen(function* () {
			const sink = yield* WorkflowEventSink
			yield* sink.onWorkflowJob(orgId, job, [])
			yield* sink.onWorkflowJobLog(orgId, job, Stream.fromIterable(lines))

			const [jobSpan, , installStep, testStep] = spansOf(calls[0]!)
			const records = recordsOf(logCalls).slice(1)
			const [beforeSteps] = recordsOf(logCalls)
			assert.strictEqual(beforeSteps!.spanId, jobSpan!.spanId)
			assert.strictEqual(attr(beforeSteps!.attributes, "cicd.pipeline.task.run.id"), job.jobId)
			assert.deepStrictEqual(
				records.map((record) => [record.body.stringValue, record.severityText, record.spanId]),
				[
					["Run bun install", "INFO", installStep!.spanId],
					["FAIL src/math.test.ts", "INFO", testStep!.spanId],
					["  expected 2 to be 3", "INFO", testStep!.spanId],
					["Process completed with exit code 1.", "ERROR", testStep!.spanId],
				],
			)
			assert.isTrue(records.every((record) => record.traceId === testStep!.traceId))
			assert.strictEqual(records[0]!.timeUnixNano, `${job.startedAtMs + 123}000000`)
			// A line without a stamp takes the one before it.
			assert.strictEqual(records[2]!.timeUnixNano, records[1]!.timeUnixNano)
			assert.strictEqual(
				attr(records[1]!.attributes, "cicd.pipeline.task.run.id"),
				attr(testStep!.attributes, "cicd.pipeline.task.run.id"),
			)
			assert.strictEqual(attr(records[1]!.attributes, "cicd.pipeline.task.name"), "Test")
			assert.strictEqual(
				attr(logCalls[0]!.resourceLogs[0]!.resource.attributes, "service.name"),
				"github-actions",
			)
		}).pipe(Effect.provide(sinkLayer(testDb, recordingFetch(calls, [200], logCalls))))
	})

	it.live("places lines on the step that printed them when steps share a second", () => {
		const testDb = createTestDb(trackedDbs)
		const logCalls: Array<OtlpLogsRequest> = []
		// The step layout of a real Maple CI job: the API gives whole seconds, skipped steps take the
		// next step's start, and the post steps all start and end in one second.
		const at = (seconds: number) => job.startedAtMs + seconds * 1000
		const step = (number: number, name: string, start: number, end: number, conclusion = "success") => ({
			number,
			name,
			conclusion,
			startedAtMs: at(start),
			completedAtMs: at(end),
		})
		const tied: WorkflowJobJob = {
			...job,
			steps: [
				step(2, "Run actions/checkout", 0, 0),
				step(3, "Run ./.github/actions/setup", 0, 20),
				step(4, "Read Playwright version", 20, 20, "skipped"),
				step(5, "Cache Chromium", 20, 20, "skipped"),
				step(7, "Run bounded test lane", 20, 151),
				// Named "Post …" but not a post step: only a step's own header opens it.
				step(8, "Post the PR comment", 151, 152),
				step(13, "Post Run ./.github/actions/setup", 152, 152),
				step(14, "Post Run actions/checkout", 152, 152),
				step(15, "Complete job", 152, 152),
			],
		}
		const lines = [
			stamped(10, "##[group]Run actions/checkout@v5"),
			stamped(100, "##[group]Run ./.github/actions/setup"),
			stamped(20_348, "Cache restored"),
			stamped(20_359, "##[group]Run bun run test"),
			stamped(90_000, "RUN v4 /home/runner/work/maple"),
			stamped(151_010, "Test Files  12 passed (12)"),
			stamped(151_900, "##[group]Run actions/github-script@v8"),
			stamped(152_010, "Comment updated"),
			stamped(152_059, "Post job cleanup."),
			stamped(152_282, "Cache hit for: turbogha"),
			stamped(152_470, "Post job cleanup."),
			stamped(152_520, "[command]/usr/bin/git version"),
			stamped(152_760, "Cleaning up orphan processes"),
		]
		return Effect.gen(function* () {
			const sink = yield* WorkflowEventSink
			yield* sink.onWorkflowJobLog(orgId, tied, Stream.fromIterable(lines))

			assert.deepStrictEqual(
				recordsOf(logCalls).map((record) => [
					record.body.stringValue,
					attr(record.attributes, "cicd.pipeline.task.name"),
				]),
				[
					["Run actions/checkout@v5", "Run actions/checkout"],
					["Run ./.github/actions/setup", "Run ./.github/actions/setup"],
					["Cache restored", "Run ./.github/actions/setup"],
					["Run bun run test", "Run bounded test lane"],
					["RUN v4 /home/runner/work/maple", "Run bounded test lane"],
					["Test Files  12 passed (12)", "Run bounded test lane"],
					["Run actions/github-script@v8", "Post the PR comment"],
					["Comment updated", "Post the PR comment"],
					["Post job cleanup.", "Post Run ./.github/actions/setup"],
					["Cache hit for: turbogha", "Post Run ./.github/actions/setup"],
					["Post job cleanup.", "Post Run actions/checkout"],
					["[command]/usr/bin/git version", "Post Run actions/checkout"],
					["Cleaning up orphan processes", "Complete job"],
				],
			)
		}).pipe(Effect.provide(sinkLayer(testDb, recordingFetch([], [200], logCalls))))
	})

	it.live("stops reading a long log at the cap and says where the rest is", () => {
		const testDb = createTestDb(trackedDbs)
		const logCalls: Array<OtlpLogsRequest> = []
		const line = "x".repeat(1000)
		const kept = MAX_JOB_LOG_CHARS / line.length
		let pulled = 0
		const lines = Stream.fromIterable({
			*[Symbol.iterator]() {
				for (;;) {
					pulled++
					yield stamped(30_000, line)
				}
			},
		})
		return Effect.gen(function* () {
			const sink = yield* WorkflowEventSink
			yield* sink.onWorkflowJobLog(orgId, job, lines)

			const records = recordsOf(logCalls)
			assert.lengthOf(records, kept + 1)
			assert.match(records.at(-1)!.body.stringValue, /^Log truncated: .*actions\/runs\/9001\/job\/555$/)
			assert.strictEqual(records.at(-1)!.severityText, "WARN")
			assert.isTrue(logCalls.every((call) => recordsOf([call]).length <= 1000))
			// Reading stops within a chunk of the cap, not at the end of an endless log.
			assert.isBelow(pulled, kept * 2)
		}).pipe(Effect.provide(sinkLayer(testDb, recordingFetch([], [200], logCalls))))
	})

	it.live("records a log that cannot be read on its span, without failing the webhook job", () => {
		const testDb = createTestDb(trackedDbs)
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
			yield* sink
				.onWorkflowJobLog(orgId, job, Stream.fail("log download reset"))
				.pipe(Effect.provideService(Tracer.Tracer, tracer))
			const emitLog = spans.find((span) => span.name === "CiTraceService.emitLog")
			assert.strictEqual(emitLog?.status._tag, "Ended")
			if (emitLog?.status._tag !== "Ended") return
			assert.isTrue(Exit.isFailure(emitLog.status.exit))
			assert.strictEqual(emitLog.attributes.get("maple.cicd.outcome"), "log_failed")
		}).pipe(Effect.provide(sinkLayer(testDb, recordingFetch([]))))
	})
})
