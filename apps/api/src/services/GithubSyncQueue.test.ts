import { afterEach, describe, expect, it, vi } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { layerFromEnvRecord } from "@maple/effect-cloudflare/worker-environment"
import type { GithubSyncJob } from "@maple/domain/queues/github-jobs"
import { GithubSyncQueueEnqueueError } from "@maple/domain/http"
import { GithubSyncQueue as GithubSyncQueueLive } from "./GithubSyncQueue"
import { cleanupTempDirs, createTempDbUrl as makeTempDb } from "./test-sqlite"
import { fullGithubConfig, makeBaseLayer } from "./github-test-helpers"

const createdTempDirs: string[] = []
afterEach(() => cleanupTempDirs(createdTempDirs))
const tempDb = () => makeTempDb("maple-github-queue-", createdTempDirs)

interface StubQueue {
	send: ReturnType<typeof vi.fn>
	sendBatch: ReturnType<typeof vi.fn>
}

const okStub = (): StubQueue => ({
	send: vi.fn(() => Promise.resolve()),
	sendBatch: vi.fn(() => Promise.resolve()),
})

const throwingStub = (): StubQueue => ({
	send: vi.fn(() => Promise.reject(new Error("queue down"))),
	sendBatch: vi.fn(() => Promise.reject(new Error("queue down"))),
})

const makeLayer = (binding: unknown) => {
	const { url } = tempDb()
	return GithubSyncQueueLive.layer.pipe(
		Layer.provide(layerFromEnvRecord({ GITHUB_SYNC_QUEUE: binding })),
		Layer.provide(makeBaseLayer(fullGithubConfig(url))),
	)
}

const sampleJob: GithubSyncJob = {
	_tag: "ResolveUnknownSha",
	orgId: "org_1",
	sha: "deadbeef",
}

describe("GithubSyncQueue", () => {
	describe("when binding is healthy", () => {
		it("enqueue forwards the encoded payload to send()", async () => {
			const stub = okStub()
			await Effect.runPromise(
				Effect.gen(function* () {
					const q = yield* GithubSyncQueueLive
					yield* q.enqueue(sampleJob)
				}).pipe(Effect.provide(makeLayer(stub))),
			)
			expect(stub.send).toHaveBeenCalledTimes(1)
			expect(stub.send.mock.calls[0]![0]).toMatchObject({
				_tag: "ResolveUnknownSha",
				sha: "deadbeef",
			})
		})

		it("enqueue forwards delaySeconds option", async () => {
			const stub = okStub()
			await Effect.runPromise(
				Effect.gen(function* () {
					const q = yield* GithubSyncQueueLive
					yield* q.enqueue(sampleJob, { delaySeconds: 30 })
				}).pipe(Effect.provide(makeLayer(stub))),
			)
			expect(stub.send.mock.calls[0]![1]).toEqual({ delaySeconds: 30 })
		})

		it("enqueueBatch sends one envelope per job", async () => {
			const stub = okStub()
			await Effect.runPromise(
				Effect.gen(function* () {
					const q = yield* GithubSyncQueueLive
					yield* q.enqueueBatch([sampleJob, sampleJob, sampleJob])
				}).pipe(Effect.provide(makeLayer(stub))),
			)
			expect(stub.sendBatch).toHaveBeenCalledTimes(1)
			const messages = stub.sendBatch.mock.calls[0]![0] as Array<{ body: unknown }>
			expect(messages).toHaveLength(3)
		})

		it("enqueueBatch short-circuits for empty list", async () => {
			const stub = okStub()
			await Effect.runPromise(
				Effect.gen(function* () {
					const q = yield* GithubSyncQueueLive
					yield* q.enqueueBatch([])
				}).pipe(Effect.provide(makeLayer(stub))),
			)
			expect(stub.sendBatch).not.toHaveBeenCalled()
		})
	})

	describe("when binding throws", () => {
		it("enqueue surfaces GithubSyncQueueEnqueueError after retries", async () => {
			const stub = throwingStub()
			const exit = await Effect.runPromiseExit(
				Effect.gen(function* () {
					const q = yield* GithubSyncQueueLive
					yield* q.enqueue(sampleJob)
				}).pipe(Effect.provide(makeLayer(stub))),
			)
			expect(Exit.isFailure(exit)).toBe(true)
			if (Exit.isFailure(exit)) {
				const error = exit.cause.toString()
				expect(error).toContain(GithubSyncQueueEnqueueError.name)
			}
			// Retry schedule: initial + 3 retries = 4 attempts.
			expect(stub.send).toHaveBeenCalledTimes(4)
		})

		it("enqueueBatch surfaces GithubSyncQueueEnqueueError after retries", async () => {
			const stub = throwingStub()
			const exit = await Effect.runPromiseExit(
				Effect.gen(function* () {
					const q = yield* GithubSyncQueueLive
					yield* q.enqueueBatch([sampleJob])
				}).pipe(Effect.provide(makeLayer(stub))),
			)
			expect(Exit.isFailure(exit)).toBe(true)
			expect(stub.sendBatch).toHaveBeenCalledTimes(4)
		})
	})
})
