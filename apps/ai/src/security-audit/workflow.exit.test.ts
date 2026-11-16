import { afterEach, describe, expect, it } from "@effect/vitest"
import { asOrgId, asUserId } from "@maple/backend/services/integrations/vcs/__tests__/harness"
import { SecurityAuditStore } from "@maple/backend/services/security-audit/SecurityAuditStore"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { AuditStoreError } from "@maple/security-audit"
import { Cause, Effect, Exit, Layer } from "effect"
import * as SecureRandom from "effect/crypto/SecureRandom"
import { SecurityPrCheck } from "./pr-check"
import { reportPullRequestCheckOnExit } from "./workflow.run"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const orgId = asOrgId("org_exit_hook")

const makeHarness = () => {
	const db = createTestDb(trackedDbs)
	const published: Array<string> = []
	const layer = Layer.mergeAll(
		SecurityAuditStore.layer.pipe(Layer.provide(db.layer)),
		Layer.succeed(SecurityPrCheck, {
			notify: () => Effect.void,
			publish: (_org, runId) => Effect.sync(() => void published.push(runId)),
		}),
		SecureRandom.layerWebCrypto,
	)
	/** A pull request run, unfinished unless `settle` finishes it. */
	const seededRun = Effect.gen(function* () {
		const store = (yield* SecurityAuditStore).forOrg(orgId)
		const target = yield* store.createTarget({
			repository: "octo/repo",
			branch: "main",
			createdBy: asUserId("user_1"),
		})
		return yield* store.startRun({
			targetId: target.id,
			kind: "pull_request",
			prNumber: 7,
			sourceRef: "1111111111111111111111111111111111111111",
		})
	})
	const run = <A, E>(body: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
		Effect.runPromise(body.pipe(Effect.provide(layer)))
	const statusOf = (runId: string) =>
		Effect.gen(function* () {
			const row = yield* (yield* SecurityAuditStore).forOrg(orgId).getRun(runId)
			return row._tag === "Some" ? row.value.status : null
		})
	return { run, seededRun, statusOf, published }
}

describe("reportPullRequestCheckOnExit", () => {
	it("settles a run that died before its body ran, then reports its check", async () => {
		const harness = makeHarness()
		const status = await harness.run(
			Effect.gen(function* () {
				const run = yield* harness.seededRun
				yield* reportPullRequestCheckOnExit(
					{ orgId, runId: run.id },
					Exit.fail(new AuditStoreError({ message: "could not load the LLM settings" })),
				)
				return { id: run.id, status: yield* harness.statusOf(run.id) }
			}),
		)

		expect(status.status).toBe("failed")
		expect(harness.published).toEqual([status.id])
	})

	it("keeps the outcome a run's body already settled", async () => {
		const harness = makeHarness()
		const status = await harness.run(
			Effect.gen(function* () {
				const run = yield* harness.seededRun
				yield* (yield* SecurityAuditStore).forOrg(orgId).finishRun(run.id, { status: "complete" })
				yield* reportPullRequestCheckOnExit(
					{ orgId, runId: run.id },
					Exit.fail(new AuditStoreError({ message: "late" })),
				)
				return yield* harness.statusOf(run.id)
			}),
		)

		expect(status).toBe("complete")
		expect(harness.published.length).toBe(1)
	})

	it("leaves an evicted run for its replay, and reports a run that exited normally", async () => {
		const harness = makeHarness()
		const result = await harness.run(
			Effect.gen(function* () {
				const evicted = yield* harness.seededRun
				yield* reportPullRequestCheckOnExit(
					{ orgId, runId: evicted.id },
					Exit.failCause(Cause.interrupt()),
				)
				const evictedStatus = yield* harness.statusOf(evicted.id)
				yield* reportPullRequestCheckOnExit({ orgId, runId: evicted.id }, Exit.void)
				return { evicted: evicted.id, evictedStatus }
			}),
		)

		expect(result.evictedStatus).toBe("in_progress")
		expect(harness.published).toEqual([result.evicted])
	})
})
