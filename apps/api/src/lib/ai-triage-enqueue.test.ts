import { afterEach, assert, describe, it } from "@effect/vitest"
import { Clock, ConfigProvider, Effect, Layer, Schema } from "effect"
import { OrgId } from "@maple/domain/http"
import { aiTriageRuns, aiTriageSettings } from "@maple/db"
import { eq } from "drizzle-orm"
import { DatabaseLibsqlLive } from "@/lib/DatabaseLibsqlLive"
import { Database } from "@/lib/DatabaseLive"
import { Env } from "@/lib/Env"
import { cleanupTempDirs, createTempDbUrl as makeTempDb } from "@/lib/test-sqlite"
import { maybeEnqueueTriage } from "./ai-triage-enqueue"

const createdTempDirs: string[] = []

afterEach(() => {
	cleanupTempDirs(createdTempDirs)
})

const testConfig = (url: string) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			MCP_PORT: "3473",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_DB_URL: url,
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const makeLayer = () => {
	const { url } = makeTempDb("maple-ai-triage-enqueue-", createdTempDirs)
	return DatabaseLibsqlLive.pipe(Layer.provideMerge(Env.layer), Layer.provide(testConfig(url)))
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const ORG = asOrgId("org_enqueue_test")

const fakeBinding = () => {
	const created: Array<{ id?: string }> = []
	return {
		created,
		binding: {
			create: async (options?: { id?: string }) => {
				created.push({ id: options?.id })
				return {}
			},
		},
	}
}

const enableSettings = Effect.gen(function* () {
	const database = yield* Database
	const nowMs = yield* Clock.currentTimeMillis
	yield* database.execute((db) =>
		db.insert(aiTriageSettings).values({
			orgId: ORG,
			enabled: 1,
			maxRunsPerDay: 2,
			updatedAt: nowMs,
		}),
	)
})

const baseInput = (binding: unknown, incidentId: string) => ({
	orgId: ORG,
	incidentKind: "error" as const,
	incidentId,
	context: { kind: "error" },
	workflowBinding: binding,
})

describe("maybeEnqueueTriage", () => {
	it.effect("does nothing when the org has not opted in", () =>
		Effect.gen(function* () {
			const { binding, created } = fakeBinding()
			const result = yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))
			assert.deepStrictEqual(result, { enqueued: false, reason: "disabled" })
			assert.lengthOf(created, 0)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("enqueues once and dedups subsequent calls for the same incident", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const { binding, created } = fakeBinding()

			const first = yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))
			assert.isTrue(first.enqueued)
			assert.lengthOf(created, 1)
			assert.strictEqual(created[0]?.id, first.runId)

			const second = yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))
			assert.deepStrictEqual(second, { enqueued: false, reason: "duplicate" })
			assert.lengthOf(created, 1)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("stops at the daily cap", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const { binding } = fakeBinding()

			assert.isTrue((yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))).enqueued)
			assert.isTrue((yield* maybeEnqueueTriage(baseInput(binding, "incident-2"))).enqueued)
			const third = yield* maybeEnqueueTriage(baseInput(binding, "incident-3"))
			assert.deepStrictEqual(third, { enqueued: false, reason: "daily_cap" })
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("marks the run failed when no workflow binding is available", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const database = yield* Database

			const result = yield* maybeEnqueueTriage({
				...baseInput(undefined, "incident-1"),
				workflowBinding: undefined,
			})
			assert.isFalse(result.enqueued)
			assert.strictEqual(result.reason, "no_binding")

			const rows = yield* database.execute((db) =>
				db.select().from(aiTriageRuns).where(eq(aiTriageRuns.orgId, ORG)),
			)
			assert.lengthOf(rows, 1)
			assert.strictEqual(rows[0]?.status, "failed")
			assert.strictEqual(rows[0]?.error, "workflow_binding_unavailable")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("marks the run failed and reports `error` when workflow creation fails", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const database = yield* Database
			const failingBinding = {
				create: async () => {
					throw new Error("workflow boom")
				},
			}

			const result = yield* maybeEnqueueTriage(baseInput(failingBinding, "incident-1"))
			assert.deepStrictEqual(result, { enqueued: false, reason: "error" })

			const rows = yield* database.execute((db) =>
				db.select().from(aiTriageRuns).where(eq(aiTriageRuns.orgId, ORG)),
			)
			assert.lengthOf(rows, 1)
			assert.strictEqual(rows[0]?.status, "failed")
			assert.strictEqual(rows[0]?.error, "workflow_create_failed: workflow boom")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("reclaims a stranded non-terminal run instead of reporting duplicate", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const database = yield* Database
			const nowMs = yield* Clock.currentTimeMillis
			const { binding, created } = fakeBinding()

			// First enqueue claims the slot, then we simulate a dead workflow: the
			// row stays `running` and stops making progress for >15 minutes.
			const first = yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))
			assert.isTrue(first.enqueued)
			yield* database.execute((db) =>
				db
					.update(aiTriageRuns)
					.set({ status: "running", updatedAt: nowMs - 16 * 60 * 1000 })
					.where(eq(aiTriageRuns.orgId, ORG)),
			)

			const second = yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))
			assert.isTrue(second.enqueued)
			assert.lengthOf(created, 2)

			const rows = yield* database.execute((db) =>
				db.select().from(aiTriageRuns).where(eq(aiTriageRuns.orgId, ORG)),
			)
			assert.lengthOf(rows, 1)
			assert.strictEqual(rows[0]?.id, second.runId)
			assert.strictEqual(rows[0]?.status, "queued")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("does not reclaim a fresh non-terminal run", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const database = yield* Database
			const { binding, created } = fakeBinding()

			const first = yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))
			assert.isTrue(first.enqueued)
			yield* database.execute((db) =>
				db.update(aiTriageRuns).set({ status: "running" }).where(eq(aiTriageRuns.orgId, ORG)),
			)

			const second = yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))
			assert.deepStrictEqual(second, { enqueued: false, reason: "duplicate" })
			assert.lengthOf(created, 1)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("force bypasses the enabled flag but still requires a binding", () =>
		Effect.gen(function* () {
			const { binding, created } = fakeBinding()
			const result = yield* maybeEnqueueTriage({
				...baseInput(binding, "incident-1"),
				force: true,
			})
			assert.isTrue(result.enqueued)
			assert.lengthOf(created, 1)
		}).pipe(Effect.provide(makeLayer())),
	)
})
