import { afterEach, describe, expect, it, vi } from "vitest"
import { Effect, Layer } from "effect"
import { layerFromEnvRecord } from "@maple/effect-cloudflare/worker-environment"
import type { GithubSyncJob } from "@maple/domain/queues/github-jobs"
import { GithubSyncQueue } from "./GithubSyncQueue"
import {
	cleanupTempDirs,
	createTempDbUrl as makeTempDb,
} from "./test-sqlite"
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
	return GithubSyncQueue.layer.pipe(
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
	describe("when binding is missing", () => {
		it("isConfigured returns false", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const q = yield* GithubSyncQueue
					return yield* q.isConfigured
				}).pipe(Effect.provide(makeLayer(undefined))),
			)
			expect(result).toBe(false)
		})

		it("enqueue is a no-op (no throw)", async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const q = yield* GithubSyncQueue
					yield* q.enqueue(sampleJob)
				}).pipe(Effect.provide(makeLayer(undefined))),
			)
		})

		it("enqueueBatch is a no-op (no throw)", async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const q = yield* GithubSyncQueue
					yield* q.enqueueBatch([sampleJob, sampleJob])
				}).pipe(Effect.provide(makeLayer(undefined))),
			)
		})
	})

	describe("when binding is healthy", () => {
		it("isConfigured returns true and send is called with encoded payload", async () => {
			const stub = okStub()
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const q = yield* GithubSyncQueue
					const configured = yield* q.isConfigured
					yield* q.enqueue(sampleJob)
					return configured
				}).pipe(Effect.provide(makeLayer(stub))),
			)
			expect(result).toBe(true)
			expect(stub.send).toHaveBeenCalledTimes(1)
			const arg = stub.send.mock.calls[0]![0]
			expect(arg).toMatchObject({ _tag: "ResolveUnknownSha", sha: "deadbeef" })
		})

		it("enqueue forwards delaySeconds option", async () => {
			const stub = okStub()
			await Effect.runPromise(
				Effect.gen(function* () {
					const q = yield* GithubSyncQueue
					yield* q.enqueue(sampleJob, { delaySeconds: 30 })
				}).pipe(Effect.provide(makeLayer(stub))),
			)
			expect(stub.send.mock.calls[0]![1]).toEqual({ delaySeconds: 30 })
		})

		it("enqueueBatch sends one envelope per job", async () => {
			const stub = okStub()
			await Effect.runPromise(
				Effect.gen(function* () {
					const q = yield* GithubSyncQueue
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
					const q = yield* GithubSyncQueue
					yield* q.enqueueBatch([])
				}).pipe(Effect.provide(makeLayer(stub))),
			)
			expect(stub.sendBatch).not.toHaveBeenCalled()
		})
	})

	describe("when binding throws", () => {
		it("enqueue swallows the error (does not die)", async () => {
			const stub = throwingStub()
			await Effect.runPromise(
				Effect.gen(function* () {
					const q = yield* GithubSyncQueue
					yield* q.enqueue(sampleJob)
				}).pipe(Effect.provide(makeLayer(stub))),
			)
			expect(stub.send).toHaveBeenCalled()
		})

		it("enqueueBatch swallows the error", async () => {
			const stub = throwingStub()
			await Effect.runPromise(
				Effect.gen(function* () {
					const q = yield* GithubSyncQueue
					yield* q.enqueueBatch([sampleJob])
				}).pipe(Effect.provide(makeLayer(stub))),
			)
			expect(stub.sendBatch).toHaveBeenCalled()
		})
	})
})
