import { afterEach, describe, expect, it } from "@effect/vitest"
import { randomUUID } from "node:crypto"
import { ApiKeyId, OrgId, UserId } from "@maple/domain/http"
import { ONBOARDING_AGENT_RUN_TTL_MS, ONBOARDING_HANDOFF_TTL_MS } from "@maple/domain/onboarding-agent-run"
import { Array as Arr, Effect, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/testing/test-pglite"
import { OnboardingAgentRunService } from "./OnboardingAgentRunService"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const provideRuns = (db: TestDb) =>
	Effect.provide(OnboardingAgentRunService.layer.pipe(Layer.provide(db.layer)))

const orgId = Schema.decodeSync(OrgId)("org_onboard")
const userId = Schema.decodeSync(UserId)("user_onboard")
const owner = { orgId, userId }
let hashes = 0
const nextHash = () => `handoff-hash-${(hashes += 1)}`

describe("OnboardingAgentRunService", () => {
	it.effect("records stages and keeps the agent's services and verification trace", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const runs = yield* OnboardingAgentRunService
			const started = yield* runs.start(owner, nextHash())
			expect(started.status).toBe("waiting_for_agent")
			expect(Arr.map(started.stages, (stage) => stage.status)).toEqual(Arr.replicate("pending", 6))

			yield* runs.report(owner, { stage: "connect_agent", status: "completed" })
			yield* runs.report(owner, {
				stage: "instrument_app",
				status: "active",
				note: "  Instrumenting\ntwo\u202e services\u200b ",
				serviceNames: ["api", "web"],
			})
			const verified = yield* runs.report(owner, {
				stage: "receive_verification",
				status: "completed",
				serviceNames: ["api"],
				traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
			})

			expect(verified.status).toBe("in_progress")
			expect(verified.serviceNames).toEqual(["api", "web"])
			expect(verified.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
			const stageOf = (id: string) => Arr.findFirst(verified.stages, (stage) => stage.stage === id)
			expect(Option.map(stageOf("connect_agent"), (stage) => stage.status)).toEqual(
				Option.some("completed"),
			)
			expect(Option.map(stageOf("instrument_app"), (stage) => stage.note)).toEqual(
				Option.some("Instrumenting two services"),
			)
			expect(Option.map(stageOf("analyze_project"), (stage) => stage.status)).toEqual(
				Option.some("pending"),
			)
		}).pipe(provideRuns(db))
	})

	it.effect("reports go to the newest run, and a closed run refuses them", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const runs = yield* OnboardingAgentRunService
			yield* runs.start(owner, nextHash())
			yield* TestClock.adjust("1 second")
			const newest = yield* runs.start(owner, nextHash())

			const done = yield* runs.report(owner, {
				stage: "prepare_production",
				status: "completed",
				runStatus: "completed",
			})
			expect(done.id).toBe(newest.id)
			expect(done.status).toBe("completed")

			const refused = yield* runs
				.report(owner, { stage: "prepare_production", status: "active" })
				.pipe(Effect.flip)
			expect(refused._tag).toBe("@maple/http/errors/OnboardingAgentRunClosedError")
		}).pipe(provideRuns(db))
	})

	it.effect("a newer run closes the older one, and an unclaimed run lapses with its code", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const runs = yield* OnboardingAgentRunService
			const first = yield* runs.start(owner, nextHash())
			yield* runs.report(owner, { stage: "connect_agent", status: "completed" })
			yield* TestClock.adjust("1 second")
			const second = yield* runs.start(owner, nextHash())
			expect(second.id).not.toBe(first.id)
			expect((yield* runs.current(owner)).status).toBe("waiting_for_agent")

			yield* TestClock.adjust(ONBOARDING_HANDOFF_TTL_MS)
			expect((yield* runs.current(owner)).status).toBe("expired")
		}).pipe(provideRuns(db))
	})

	it.effect("a run whose code was claimed stays open past the code's lapse, even before any report", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const runs = yield* OnboardingAgentRunService
			const started = yield* runs.start(owner, nextHash())
			// What the CLI's claim does: bind the minted key to the run.
			const apiKeyId = randomUUID()
			yield* Effect.promise(() =>
				executeSql(db, "update onboarding_agent_runs set api_key_id = $1 where id = $2", [
					apiKeyId,
					started.id,
				]),
			)
			yield* TestClock.adjust(ONBOARDING_HANDOFF_TTL_MS + 60_000)
			const keyCaller = { ...owner, apiKeyId: Schema.decodeSync(ApiKeyId)(apiKeyId) }
			expect((yield* runs.current(keyCaller)).status).toBe("waiting_for_agent")
			const reported = yield* runs.report(keyCaller, { stage: "connect_agent", status: "completed" })
			expect(reported.status).toBe("in_progress")
		}).pipe(provideRuns(db))
	})

	it.effect("concurrent reports all land and none reopens a closed run", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const runs = yield* OnboardingAgentRunService
			yield* runs.start(owner, nextHash())
			yield* Effect.forEach(
				["connect_agent", "analyze_project", "instrument_app"] as const,
				(stage) => runs.report(owner, { stage, status: "completed" }),
				{ concurrency: "unbounded" },
			)
			const run = yield* runs.current(owner)
			expect(Arr.filter(run.stages, (stage) => stage.status === "completed").length).toBe(3)
		}).pipe(provideRuns(db))
	})

	it.effect("an API key reaches only the run it was minted for, never the person's newest", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const runs = yield* OnboardingAgentRunService
			yield* runs.start(owner, nextHash())
			const otherKey = { ...owner, apiKeyId: Schema.decodeSync(ApiKeyId)(randomUUID()) }
			const read = yield* runs.current(otherKey).pipe(Effect.flip)
			expect(read._tag).toBe("@maple/http/errors/OnboardingAgentRunNotFoundError")
			const write = yield* runs
				.report(otherKey, { stage: "connect_agent", status: "active" })
				.pipe(Effect.flip)
			expect(write._tag).toBe("@maple/http/errors/OnboardingAgentRunNotFoundError")
		}).pipe(provideRuns(db))
	})

	it.effect("a run a day old reads as expired and takes no more reports", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const runs = yield* OnboardingAgentRunService
			yield* runs.start(owner, nextHash())
			yield* TestClock.adjust(ONBOARDING_AGENT_RUN_TTL_MS)

			expect((yield* runs.current(owner)).status).toBe("expired")
			const refused = yield* runs
				.report(owner, { stage: "connect_agent", status: "active" })
				.pipe(Effect.flip)
			expect(refused._tag).toBe("@maple/http/errors/OnboardingAgentRunClosedError")
		}).pipe(provideRuns(db))
	})

	it.effect("another org or person never sees or reports to the run", () => {
		const db = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const runs = yield* OnboardingAgentRunService
			yield* runs.start(owner, nextHash())
			const otherOrg = { orgId: Schema.decodeSync(OrgId)("org_other"), userId }
			const otherUser = { orgId, userId: Schema.decodeSync(UserId)("user_other") }

			yield* Effect.forEach([otherOrg, otherUser], (stranger) =>
				Effect.gen(function* () {
					const read = yield* runs.current(stranger).pipe(Effect.flip)
					expect(read._tag).toBe("@maple/http/errors/OnboardingAgentRunNotFoundError")
					const write = yield* runs
						.report(stranger, { stage: "connect_agent", status: "active" })
						.pipe(Effect.flip)
					expect(write._tag).toBe("@maple/http/errors/OnboardingAgentRunNotFoundError")
				}),
			)
			expect((yield* runs.current(owner)).status).toBe("waiting_for_agent")
		}).pipe(provideRuns(db))
	})
})
