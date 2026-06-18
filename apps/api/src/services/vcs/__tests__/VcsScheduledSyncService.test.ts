import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId, VcsQueueError, type VcsSyncJob } from "@maple/domain/http"
import { ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import { DatabaseLibsqlLive } from "@/lib/DatabaseLibsqlLive"
import { Env } from "@/lib/Env"
import { cleanupTempDirs, createTempDbUrl } from "@/lib/test-sqlite"
import { VcsRepository } from "@/services/vcs/VcsRepository"
import { VcsScheduledSyncService } from "@/services/vcs/VcsScheduledSyncService"
import { VcsSyncQueue, type VcsSyncQueueShape } from "@/services/vcs/VcsSyncQueue"

const dirs: string[] = []
afterEach(() => cleanupTempDirs(dirs))

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const config = (url: string) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_DB_URL: url,
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

const expectSome = <A>(o: Option.Option<A>): A => {
	assert.ok(Option.isSome(o), "expected Option.some, got none")
	return o.value
}

// Wire VcsScheduledSyncService over a temp sqlite (real repo) and a recording
// VcsSyncQueue (Layer.succeed) that captures every enqueued job. When `failQueue`
// is set, `sendBatch` fails with a VcsQueueError instead, to exercise propagation.
const schedulerLayer = (
	url: string,
	sent: Array<VcsSyncJob>,
	opts?: { readonly failQueue?: boolean },
) => {
	const env = Env.layer.pipe(Layer.provide(config(url)))
	const data = VcsRepository.layer.pipe(Layer.provide(DatabaseLibsqlLive), Layer.provide(env))
	const queue = Layer.succeed(VcsSyncQueue, {
		send: (job) => Effect.sync(() => void sent.push(job)),
		sendBatch: (jobs) =>
			opts?.failQueue
				? Effect.fail(new VcsQueueError({ message: "simulated queue outage" }))
				: Effect.sync(() => void sent.push(...jobs)),
	} satisfies VcsSyncQueueShape)
	const service = VcsScheduledSyncService.layer.pipe(Layer.provide(Layer.mergeAll(data, queue)))
	return Layer.mergeAll(service, data)
}

// Seed one installation for an org with a given external id; returns the entity.
const seedInstallation = (repo: VcsRepository, orgId: OrgId, externalInstallationId: string) =>
	Effect.gen(function* () {
		yield* repo.upsertInstallation({
			orgId,
			provider: "github",
			externalInstallationId,
			accountLogin: `octo-${externalInstallationId}`,
			accountType: "organization",
			externalAccountId: `acct-${externalInstallationId}`,
			accountAvatarUrl: null,
			repositorySelection: "all",
			installedByUserId: asUserId("user_1"),
		})
		return expectSome(yield* repo.resolveInstallation("github", externalInstallationId))
	})

describe("VcsScheduledSyncService.runScheduledSync", () => {
	it.effect("enqueues one scheduled installation-sync per installation across orgs", () => {
		const { url } = createTempDbUrl("maple-vcs-sched-multi-", dirs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsScheduledSyncService
			const repo = yield* VcsRepository
			yield* seedInstallation(repo, asOrgId("org_a"), "1")
			yield* seedInstallation(repo, asOrgId("org_b"), "2")

			const result = yield* svc.runScheduledSync()

			assert.strictEqual(result.installationsTotal, 2)
			assert.strictEqual(result.enqueued, 2)
			assert.strictEqual(result.skipped, 0)
			assert.strictEqual(sent.length, 2)
			assert.ok(
				sent.every((j) => j.kind === "installation-sync" && j.reason === "scheduled"),
				"every job is a scheduled installation-sync",
			)
			assert.deepStrictEqual(
				sent.map((j) => j.externalInstallationId).sort(),
				["1", "2"],
			)
		}).pipe(Effect.provide(schedulerLayer(url, sent)))
	})

	it.effect("skips suspended and disconnected installations (the processable gate)", () => {
		const { url } = createTempDbUrl("maple-vcs-sched-gate-", dirs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsScheduledSyncService
			const repo = yield* VcsRepository
			const active = yield* seedInstallation(repo, asOrgId("org_a"), "1")
			const suspended = yield* seedInstallation(repo, asOrgId("org_b"), "2")
			const disconnected = yield* seedInstallation(repo, asOrgId("org_c"), "3")
			yield* repo.markInstallationStatus(suspended.id, "suspended")
			yield* repo.markInstallationStatus(disconnected.id, "disconnected")

			const result = yield* svc.runScheduledSync()

			assert.strictEqual(result.installationsTotal, 3)
			assert.strictEqual(result.enqueued, 1)
			assert.strictEqual(result.skipped, 2)
			assert.strictEqual(sent.length, 1)
			assert.strictEqual(sent[0]?.externalInstallationId, active.externalInstallationId)
		}).pipe(Effect.provide(schedulerLayer(url, sent)))
	})

	it.effect("enqueues nothing when there are no installations", () => {
		const { url } = createTempDbUrl("maple-vcs-sched-empty-", dirs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsScheduledSyncService
			const result = yield* svc.runScheduledSync()
			assert.strictEqual(result.installationsTotal, 0)
			assert.strictEqual(result.enqueued, 0)
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(schedulerLayer(url, sent)))
	})

	it.effect("propagates a queue failure as VcsQueueError", () => {
		const { url } = createTempDbUrl("maple-vcs-sched-qfail-", dirs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* VcsScheduledSyncService
			const repo = yield* VcsRepository
			yield* seedInstallation(repo, asOrgId("org_a"), "1")
			const exit = yield* Effect.exit(svc.runScheduledSync())
			assert.ok(Exit.isFailure(exit), "the tick surfaces the queue failure")
			const error = Option.getOrUndefined(Exit.findErrorOption(exit))
			assert.strictEqual(error?._tag, "@maple/http/errors/VcsQueueError")
		}).pipe(Effect.provide(schedulerLayer(url, sent, { failQueue: true })))
	})
})
