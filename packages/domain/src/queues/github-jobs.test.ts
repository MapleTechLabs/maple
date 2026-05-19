import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import {
	decodeGithubSyncJob,
	encodeGithubSyncJob,
	type GithubSyncJob,
} from "./github-jobs"

const roundTrip = (job: GithubSyncJob) =>
	Effect.gen(function* () {
		const encoded = yield* encodeGithubSyncJob(job)
		const decoded = yield* decodeGithubSyncJob(encoded)
		return decoded
	})

describe("GithubSyncJob schema", () => {
	it("round-trips BackfillRepo with cursor", async () => {
		const job: GithubSyncJob = {
			_tag: "BackfillRepo",
			orgId: "org_1",
			repoId: "repo_1",
			sinceUnixMs: 1700000000000,
			cursor: "https://api.github.com/repos/x/y/commits?page=2",
		}
		const decoded = await Effect.runPromise(roundTrip(job))
		expect(decoded).toEqual(job)
	})

	it("round-trips BackfillRepo with null cursor", async () => {
		const job: GithubSyncJob = {
			_tag: "BackfillRepo",
			orgId: "org_1",
			repoId: "repo_1",
			sinceUnixMs: 1700000000000,
			cursor: null,
		}
		const decoded = await Effect.runPromise(roundTrip(job))
		expect(decoded).toEqual(job)
	})

	it("round-trips SyncWebhookPush", async () => {
		const job: GithubSyncJob = {
			_tag: "SyncWebhookPush",
			orgId: "org_1",
			installationId: 12345,
			owner: "JeremyFunk",
			name: "maple",
			ref: "refs/heads/main",
			before: "0".repeat(40),
			after: "1".repeat(40),
			forced: false,
			commitShas: ["a".repeat(40), "b".repeat(40)],
		}
		const decoded = await Effect.runPromise(roundTrip(job))
		expect(decoded).toEqual(job)
	})

	it("round-trips ResolveUnknownSha", async () => {
		const job: GithubSyncJob = {
			_tag: "ResolveUnknownSha",
			orgId: "org_1",
			sha: "abc1234",
		}
		const decoded = await Effect.runPromise(roundTrip(job))
		expect(decoded).toEqual(job)
	})

	it("round-trips ReconcileInstallation", async () => {
		const job: GithubSyncJob = {
			_tag: "ReconcileInstallation",
			orgId: "org_1",
			installationId: 12345,
		}
		const decoded = await Effect.runPromise(roundTrip(job))
		expect(decoded).toEqual(job)
	})

	it("rejects payload with unknown tag", async () => {
		const exit = await Effect.runPromiseExit(
			decodeGithubSyncJob({ _tag: "NotAJob", orgId: "x" } as unknown),
		)
		expect(Exit.isFailure(exit)).toBe(true)
	})

	it("rejects payload missing required field", async () => {
		const exit = await Effect.runPromiseExit(
			decodeGithubSyncJob({ _tag: "ResolveUnknownSha", orgId: "org_1" } as unknown),
		)
		expect(Exit.isFailure(exit)).toBe(true)
	})

	it("encodes a job with plain-object payload (no class instance required)", async () => {
		// Regression: TaggedClass required `new GithubResolveUnknownShaJob(...)`,
		// breaking every callsite that passes plain objects. TaggedStruct keeps
		// the plain-object path working.
		const plain = {
			_tag: "ResolveUnknownSha" as const,
			orgId: "org_1",
			sha: "deadbeef",
		}
		const encoded = await Effect.runPromise(encodeGithubSyncJob(plain))
		expect(encoded).toBeTruthy()
		const decoded = await Effect.runPromise(decodeGithubSyncJob(encoded))
		expect(decoded).toEqual(plain)
	})
})
