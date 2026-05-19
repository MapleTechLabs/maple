import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { GithubAppJwtService } from "./GithubAppJwtService"
import { GithubInstallationClient } from "./GithubInstallationClient"
import {
	cleanupTempDirs,
	createTempDbUrl as makeTempDb,
} from "./test-sqlite"
import { fullGithubConfig, makeBaseLayer } from "./github-test-helpers"

const createdTempDirs: string[] = []
afterEach(() => cleanupTempDirs(createdTempDirs))
const tempDb = () => makeTempDb("maple-github-client-", createdTempDirs)

const makeLayer = () => {
	const { url } = tempDb()
	return GithubInstallationClient.layer.pipe(
		Layer.provide(GithubAppJwtService.layer),
		Layer.provide(makeBaseLayer(fullGithubConfig(url))),
	)
}

// Build a fetch-mock that handles:
//  - POST /app/installations/<id>/access_tokens → returns a fake installation token
//  - everything else: dispatches to `routes[url-suffix]`
const buildFetchMock = (routes: Record<string, () => Response>) =>
	vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString()
		if (url.endsWith("/access_tokens")) {
			return new Response(
				JSON.stringify({
					token: "ghs_test_token",
					expires_at: new Date(Date.now() + 3600_000).toISOString(),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)
		}
		for (const [path, factory] of Object.entries(routes)) {
			if (url.includes(path)) return factory()
		}
		return new Response("not found", { status: 404 })
	})

const jsonResponse = (status: number, body: unknown, link?: string) => {
	const headers: Record<string, string> = { "content-type": "application/json" }
	if (link) headers.link = link
	return new Response(JSON.stringify(body), { status, headers })
}

const repoPayload = (id: number, name: string) => ({
	id,
	name,
	full_name: `acme/${name}`,
	owner: { id: 1, login: "acme", type: "Organization" },
	private: false,
	html_url: `https://github.com/acme/${name}`,
	default_branch: "main",
})

const commitPayload = (sha: string) => ({
	sha,
	html_url: `https://github.com/acme/repo/commit/${sha}`,
	commit: {
		message: "msg",
		author: { name: "x", email: "x@x", date: "2026-01-01T00:00:00Z" },
		committer: { name: "x", email: "x@x", date: "2026-01-01T00:00:00Z" },
	},
	author: { login: "x", id: 1 },
	committer: { login: "x", id: 1 },
})

describe("GithubInstallationClient", () => {
	const realFetch = globalThis.fetch
	beforeEach(() => {
		vi.restoreAllMocks()
	})
	afterEach(() => {
		globalThis.fetch = realFetch
	})

	describe("listInstallationRepositories", () => {
		it("returns a single page", async () => {
			globalThis.fetch = buildFetchMock({
				"/installation/repositories": () =>
					jsonResponse(200, {
						total_count: 2,
						repositories: [repoPayload(1, "a"), repoPayload(2, "b")],
					}),
			}) as unknown as typeof fetch

			const repos = await Effect.runPromise(
				Effect.gen(function* () {
					const c = yield* GithubInstallationClient
					return yield* c.listInstallationRepositories(12345)
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(repos.map((r) => r.name)).toEqual(["a", "b"])
		})

		it("paginates through Link: rel=\"next\"", async () => {
			let call = 0
			globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
				const url = typeof input === "string" ? input : input.toString()
				if (url.endsWith("/access_tokens")) {
					return new Response(
						JSON.stringify({
							token: "x",
							expires_at: new Date(Date.now() + 3600_000).toISOString(),
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					)
				}
				if (url.includes("/installation/repositories")) {
					call++
					if (call === 1) {
						return jsonResponse(
							200,
							{ total_count: 3, repositories: [repoPayload(1, "a"), repoPayload(2, "b")] },
							'<https://api.github.com/installation/repositories?page=2>; rel="next"',
						)
					}
					return jsonResponse(200, {
						total_count: 3,
						repositories: [repoPayload(3, "c")],
					})
				}
				return new Response("not found", { status: 404 })
			}) as unknown as typeof fetch

			const repos = await Effect.runPromise(
				Effect.gen(function* () {
					const c = yield* GithubInstallationClient
					return yield* c.listInstallationRepositories(12345)
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(repos.map((r) => r.name)).toEqual(["a", "b", "c"])
		})
	})

	describe("listCommitsPaginated", () => {
		it("returns commits and the next cursor from Link header", async () => {
			globalThis.fetch = buildFetchMock({
				"/repos/acme/r/commits": () =>
					jsonResponse(
						200,
						[commitPayload("a".repeat(40))],
						'<https://api.github.com/repos/acme/r/commits?page=2>; rel="next"',
					),
			}) as unknown as typeof fetch

			const page = await Effect.runPromise(
				Effect.gen(function* () {
					const c = yield* GithubInstallationClient
					return yield* c.listCommitsPaginated(12345, { owner: "acme", name: "r" })
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(page.commits).toHaveLength(1)
			expect(page.nextCursor).toContain("page=2")
		})

		it("returns empty + null cursor on 409 (empty repo)", async () => {
			globalThis.fetch = buildFetchMock({
				"/repos/acme/r/commits": () => new Response("", { status: 409 }),
			}) as unknown as typeof fetch

			const page = await Effect.runPromise(
				Effect.gen(function* () {
					const c = yield* GithubInstallationClient
					return yield* c.listCommitsPaginated(12345, { owner: "acme", name: "r" })
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(page.commits).toEqual([])
			expect(page.nextCursor).toBeNull()
		})
	})

	describe("getCommit", () => {
		it("returns null on 404", async () => {
			globalThis.fetch = buildFetchMock({
				"/repos/acme/r/commits/abc": () => new Response("", { status: 404 }),
			}) as unknown as typeof fetch

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const c = yield* GithubInstallationClient
					return yield* c.getCommit(12345, "acme", "r", "abc")
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(result).toBeNull()
		})

		it("returns null on 422 (malformed SHA)", async () => {
			globalThis.fetch = buildFetchMock({
				"/repos/acme/r/commits/abc": () => new Response("", { status: 422 }),
			}) as unknown as typeof fetch

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const c = yield* GithubInstallationClient
					return yield* c.getCommit(12345, "acme", "r", "abc")
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(result).toBeNull()
		})

		it("returns the commit on 200", async () => {
			const sha = "f".repeat(40)
			globalThis.fetch = buildFetchMock({
				[`/repos/acme/r/commits/${sha}`]: () => jsonResponse(200, commitPayload(sha)),
			}) as unknown as typeof fetch

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const c = yield* GithubInstallationClient
					return yield* c.getCommit(12345, "acme", "r", sha)
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(result?.sha).toBe(sha)
		})

		it("fails with upstream error on 500", async () => {
			globalThis.fetch = buildFetchMock({
				"/repos/acme/r/commits/abc": () => new Response("oops", { status: 500 }),
			}) as unknown as typeof fetch

			const exit = await Effect.runPromiseExit(
				Effect.gen(function* () {
					const c = yield* GithubInstallationClient
					return yield* c.getCommit(12345, "acme", "r", "abc")
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(Exit.isFailure(exit)).toBe(true)
		})
	})

	describe("getInstallationMetadata", () => {
		it("decodes the installation payload", async () => {
			globalThis.fetch = buildFetchMock({
				"/app/installations/12345": () =>
					jsonResponse(200, {
						id: 12345,
						account: { id: 1, login: "acme", type: "Organization" },
						app_slug: "maple-test",
						target_type: "Organization",
						repository_selection: "all",
						permissions: { metadata: "read" },
						events: ["push"],
						suspended_at: null,
					}),
			}) as unknown as typeof fetch

			const meta = await Effect.runPromise(
				Effect.gen(function* () {
					const c = yield* GithubInstallationClient
					return yield* c.getInstallationMetadata(12345)
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(meta.id).toBe(12345)
			expect(meta.account.login).toBe("acme")
		})

		it("fails with upstream error when GitHub returns 404 (uninstalled)", async () => {
			// The metadata endpoint uses a different code path (mints app JWT,
			// not installation token), so mock the right URL.
			globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
				const url = typeof input === "string" ? input : input.toString()
				if (url.includes("/app/installations/12345")) {
					return new Response("not found", { status: 404 })
				}
				return new Response("", { status: 200 })
			}) as unknown as typeof fetch

			const exit = await Effect.runPromiseExit(
				Effect.gen(function* () {
					const c = yield* GithubInstallationClient
					return yield* c.getInstallationMetadata(12345)
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(Exit.isFailure(exit)).toBe(true)
		})
	})

	describe("searchCommitBySha", () => {
		const sha = "a".repeat(40)
		const fakeHit = {
			sha,
			html_url: `https://github.com/acme/r/commit/${sha}`,
			commit: {
				message: "feat: thing",
				author: { name: "Jane", email: "j@x", date: "2026-05-01T00:00:00Z" },
				committer: { name: "Jane", email: "j@x", date: "2026-05-01T00:00:00Z" },
			},
			author: { login: "jane", id: 1 },
			committer: { login: "jane", id: 1 },
			repository: {
				id: 42,
				name: "r",
				full_name: "acme/r",
				owner: { login: "acme" },
			},
		}

		it("returns the first matching commit", async () => {
			globalThis.fetch = buildFetchMock({
				"/search/commits": () => jsonResponse(200, { total_count: 1, items: [fakeHit] }),
			}) as unknown as typeof fetch

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const c = yield* GithubInstallationClient
					return yield* c.searchCommitBySha(12345, sha)
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(result?.sha).toBe(sha)
			expect(result?.repository.full_name).toBe("acme/r")
		})

		it("returns null on empty results", async () => {
			globalThis.fetch = buildFetchMock({
				"/search/commits": () => jsonResponse(200, { total_count: 0, items: [] }),
			}) as unknown as typeof fetch

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const c = yield* GithubInstallationClient
					return yield* c.searchCommitBySha(12345, sha)
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(result).toBeNull()
		})

		it("returns null on 422 (rate-limit / scope) without failing", async () => {
			globalThis.fetch = buildFetchMock({
				"/search/commits": () => new Response("rate-limited", { status: 422 }),
			}) as unknown as typeof fetch

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const c = yield* GithubInstallationClient
					return yield* c.searchCommitBySha(12345, sha)
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(result).toBeNull()
		})
	})
})
