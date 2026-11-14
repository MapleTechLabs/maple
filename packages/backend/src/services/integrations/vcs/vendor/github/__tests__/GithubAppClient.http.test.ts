import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Stream, Array as Arr, String as Str } from "effect"
import { GithubAppClient } from "@maple/backend/services/integrations/vcs/vendor/github/GithubAppClient"
import {
	fakeGithubHttp,
	type FakeGithubRequest,
	GITHUB_APP_CONFIG,
	jsonResponse,
	testEnv,
} from "@maple/backend/services/integrations/vcs/__tests__/harness"
import * as VendorFake from "@maple/backend/testing/vendor-fake"

// How the client meets GitHub's transport: rate limits, redirects, retries and timeouts.

const tokenResponse = () => jsonResponse({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" })

const isTokenMint = (request: FakeGithubRequest) => Str.endsWith("/access_tokens")(request.url)

/** The client over a fake GitHub; `respond` answers everything but the token mint. */
const clientLayer = (respond: (request: FakeGithubRequest) => Response | Promise<Response>) => {
	const requests: Array<FakeGithubRequest> = []
	const http = fakeGithubHttp((request) => {
		requests.push(request)
		return isTokenMint(request) ? tokenResponse() : respond(request)
	})
	const layer = Layer.effect(GithubAppClient, GithubAppClient.make).pipe(
		Layer.provide(http),
		Layer.provide(testEnv(GITHUB_APP_CONFIG)),
	)
	return { layer, requests }
}

const apiCalls = (requests: ReadonlyArray<FakeGithubRequest>) =>
	Arr.filter(requests, (request) => !isTokenMint(request))

const secondaryLimit = (reset: string) =>
	jsonResponse(
		{ message: "You have exceeded a secondary rate limit" },
		{ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } },
	)

describe("GithubAppClient over the vendor HTTP kit", () => {
	it.effect("defers a secondary rate limit until the reset GitHub names, as a Unix time", () => {
		// The test clock stands at the epoch, so a reset at 600 is ten minutes out.
		const github = clientLayer(() => secondaryLimit("600"))
		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const error = yield* Effect.flip(client.getPullRequest("42", "octo", "shop", 7))
			assert.deepStrictEqual([error.status, error.retryAfterSeconds], [403, 600])
			assert.strictEqual(apiCalls(github.requests).length, 1)
		}).pipe(Effect.provide(github.layer))
	})

	it.effect("waits out a secondary rate limit that resets within seconds, then reads", () => {
		let served = 0
		const github = clientLayer(() => {
			served++
			return served === 1 ? secondaryLimit("5") : jsonResponse({ permission: "write" })
		})
		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const permission = yield* VendorFake.elapsing(
				client.getCollaboratorPermission("42", "octo", "shop", "mona"),
			)
			assert.strictEqual(permission, "write")
			assert.strictEqual(apiCalls(github.requests).length, 2)
		}).pipe(Effect.provide(github.layer))
	})

	it.effect("follows a renamed repository's redirect on the API host, with the token", () => {
		const github = clientLayer((request) =>
			Str.includes("/repos/octo/shop/")(request.url)
				? new Response(null, {
						status: 301,
						headers: {
							location: "https://api.github.com/repositories/99/collaborators/mona/permission",
						},
					})
				: jsonResponse({ permission: "admin" }),
		)
		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const permission = yield* client.getCollaboratorPermission("42", "octo", "shop", "mona")
			assert.strictEqual(permission, "admin")
			const [, moved] = apiCalls(github.requests)
			assert.strictEqual(
				moved?.url,
				"https://api.github.com/repositories/99/collaborators/mona/permission",
			)
			assert.strictEqual(moved?.headers["authorization"], "token installation-token")
		}).pipe(Effect.provide(github.layer))
	})

	it.effect("follows a renamed repository's redirect on a write, keeping method, body and token", () => {
		const github = clientLayer((request) =>
			Str.includes("/repos/octo/shop/")(request.url)
				? new Response(null, {
						status: 307,
						headers: { location: "https://api.github.com/repositories/99/issues/7/comments" },
					})
				: jsonResponse({ id: 1, html_url: "https://github.com/octo/shop-renamed/issues/7#c1" }),
		)
		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			yield* client.createIssueComment("42", "octo", "shop", 7, "hello")
			const [, moved] = apiCalls(github.requests)
			assert.strictEqual(moved?.url, "https://api.github.com/repositories/99/issues/7/comments")
			assert.strictEqual(moved?.method, "POST")
			assert.include(moved?.body ?? "", "hello")
			assert.strictEqual(moved?.headers["authorization"], "token installation-token")
		}).pipe(Effect.provide(github.layer))
	})

	it.effect("reads a blob through a renamed repository's redirect", () => {
		const github = clientLayer((request) =>
			Str.includes("/repos/octo/shop/")(request.url)
				? new Response(null, {
						status: 301,
						headers: { location: "https://api.github.com/repositories/99/git/blobs/abc" },
					})
				: new Response("lockfile contents"),
		)
		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const text = yield* client.getBlobText("42", "octo", "shop", "abc", 1_000)
			assert.strictEqual(text, "lockfile contents")
		}).pipe(Effect.provide(github.layer))
	})

	it.effect("mints a fresh token after GitHub rejects a cached one on a blob read", () => {
		let rejected = false
		const github = clientLayer(() => {
			if (rejected) return new Response("lockfile contents")
			rejected = true
			return jsonResponse({ message: "Bad credentials" }, { status: 401 })
		})
		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			yield* Effect.flip(client.getBlobText("42", "octo", "shop", "abc", 1_000))
			yield* client.getBlobText("42", "octo", "shop", "abc", 1_000)
			assert.strictEqual(Arr.filter(github.requests, isTokenMint).length, 2)
		}).pipe(Effect.provide(github.layer))
	})

	it.effect(
		"follows a job log's rename on the API host, then downloads the signed URL without the token",
		() => {
			const github = clientLayer((request) =>
				Str.includes("/repos/octo/shop/")(request.url)
					? new Response(null, {
							status: 301,
							headers: {
								location: "https://api.github.com/repositories/99/actions/jobs/7/logs",
							},
						})
					: Str.includes("/repositories/99/")(request.url)
						? new Response(null, {
								status: 302,
								headers: { location: "https://logs.example/signed" },
							})
						: new Response("line one\nline two\n"),
			)
			return Effect.gen(function* () {
				const client = yield* GithubAppClient
				const lines = yield* Stream.runCollect(client.streamJobLog("42", "octo", "shop", "7"))
				assert.deepStrictEqual(Arr.fromIterable(lines), ["line one", "line two"])
				const download = Arr.findFirst(
					github.requests,
					(r) => r.url === "https://logs.example/signed",
				)
				assert.isTrue(Option.isSome(download))
				assert.isUndefined(Option.getOrUndefined(download)?.headers["authorization"])
			}).pipe(Effect.provide(github.layer))
		},
	)

	it.effect("never sends the token to another host a redirect names", () => {
		const github = clientLayer(
			() =>
				new Response(null, { status: 302, headers: { location: "https://elsewhere.example/steal" } }),
		)
		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const error = yield* Effect.flip(client.getCollaboratorPermission("42", "octo", "shop", "mona"))
			assert.strictEqual(error.status, 302)
			assert.isFalse(
				Arr.some(github.requests, (request) => Str.includes("elsewhere.example")(request.url)),
			)
		}).pipe(Effect.provide(github.layer))
	})

	it.effect("posts a comment once, even when GitHub answers a 5xx", () => {
		const github = clientLayer(() => jsonResponse({ message: "Server Error" }, { status: 502 }))
		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const error = yield* Effect.flip(client.createIssueComment("42", "octo", "shop", 7, "hello"))
			assert.strictEqual(error.status, 502)
			assert.deepStrictEqual(
				Arr.map(apiCalls(github.requests), (request) => request.method),
				["POST"],
			)
		}).pipe(Effect.provide(github.layer))
	})

	it.effect("times out a read GitHub never answers instead of waiting for ever", () => {
		const github = clientLayer(() => new Promise<Response>(() => undefined))
		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const error = yield* Effect.flip(
				VendorFake.elapsing(client.getPullRequest("42", "octo", "shop", 7)),
			)
			assert.strictEqual(error._tag, "@maple/backend/vcs/GithubAppError")
			assert.isUndefined(error.status)
		}).pipe(Effect.provide(github.layer))
	})
})
