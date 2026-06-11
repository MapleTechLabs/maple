import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
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
	yield* database.execute((db) =>
		db.insert(aiTriageSettings).values({
			orgId: ORG,
			enabled: 1,
			maxRunsPerDay: 2,
			updatedAt: Date.now(),
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
			expect(result).toEqual({ enqueued: false, reason: "disabled" })
			expect(created).toHaveLength(0)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("enqueues once and dedups subsequent calls for the same incident", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const { binding, created } = fakeBinding()

			const first = yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))
			expect(first.enqueued).toBe(true)
			expect(created).toHaveLength(1)
			expect(created[0]?.id).toBe(first.runId)

			const second = yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))
			expect(second).toEqual({ enqueued: false, reason: "duplicate" })
			expect(created).toHaveLength(1)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("stops at the daily cap", () =>
		Effect.gen(function* () {
			yield* enableSettings
			const { binding } = fakeBinding()

			expect((yield* maybeEnqueueTriage(baseInput(binding, "incident-1"))).enqueued).toBe(true)
			expect((yield* maybeEnqueueTriage(baseInput(binding, "incident-2"))).enqueued).toBe(true)
			const third = yield* maybeEnqueueTriage(baseInput(binding, "incident-3"))
			expect(third).toEqual({ enqueued: false, reason: "daily_cap" })
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
			expect(result.enqueued).toBe(false)
			expect(result.reason).toBe("no_binding")

			const rows = yield* database.execute((db) =>
				db.select().from(aiTriageRuns).where(eq(aiTriageRuns.orgId, ORG)),
			)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.status).toBe("failed")
			expect(rows[0]?.error).toBe("workflow_binding_unavailable")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("force bypasses the enabled flag but still requires a binding", () =>
		Effect.gen(function* () {
			const { binding, created } = fakeBinding()
			const result = yield* maybeEnqueueTriage({
				...baseInput(binding, "incident-1"),
				force: true,
			})
			expect(result.enqueued).toBe(true)
			expect(created).toHaveLength(1)
		}).pipe(Effect.provide(makeLayer())),
	)
})
