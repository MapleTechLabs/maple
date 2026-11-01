import { assert, describe, it } from "@effect/vitest"
import { generateKeyPairSync } from "node:crypto"
import { ConfigProvider, Effect, Fiber, Layer, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Env } from "@maple/backend/platform/Env"
import { GithubAppClient } from "@maple/backend/services/integrations/vcs/vendor/github/GithubAppClient"
import { fakeGithubHttp } from "@maple/backend/services/integrations/vcs/__tests__/harness"

const privateKey = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey

const env = Env.layer.pipe(
	Layer.provide(
		ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				PORT: "3473",
				TINYBIRD_HOST: "https://api.tinybird.co",
				TINYBIRD_TOKEN: "test-token",
				MAPLE_AUTH_MODE: "self_hosted",
				MAPLE_ROOT_PASSWORD: "test-root-password",
				MAPLE_DEFAULT_ORG_ID: "default",
				MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
				MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
				GITHUB_APP_ID: "123456",
				GITHUB_APP_PRIVATE_KEY: privateKey,
			}),
		),
	),
)

const jsonResponse = (body: unknown) =>
	new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })

const tokenResponse = () => jsonResponse({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" })

// Replays `responses` in call order and records every requested URL.
const clientLayer = (responses: ReadonlyArray<Response>, requests: Array<string>) => {
	const http = fakeGithubHttp(({ url }) => {
		const response = responses[requests.length]
		requests.push(url)
		return response ?? new Response("unexpected request", { status: 500 })
	})
	return Layer.effect(GithubAppClient, GithubAppClient.make).pipe(Layer.provide(http), Layer.provide(env))
}

const SHA = "a".repeat(40)

const logRedirect = () =>
	new Response(null, { status: 302, headers: { location: "https://logs.example/job-7.txt" } })

/** Lets the fake HTTP promises settle between clock steps, so each backoff sleep is reached first. */
const advance = (steps: number) =>
	Effect.forEach(
		Array.from({ length: steps }),
		() =>
			TestClock.withLive(Effect.sleep("5 millis")).pipe(Effect.andThen(TestClock.adjust("10 seconds"))),
		{ discard: true },
	)

const storeError = (status: number, code: string) =>
	new Response(`<?xml version="1.0"?><Error><Code>${code}</Code></Error>`, { status })

describe("GithubAppClient responses that are normal states", () => {
	it.effect("decodes commits whose author is the empty object GitHub sends for an unlinked email", () => {
		const layer = clientLayer(
			[
				tokenResponse(),
				jsonResponse([
					{
						sha: SHA,
						html_url: "https://github.com/octo/shop/commit/a",
						commit: { message: "fix", author: { name: "Ann", email: "ann@example.com" } },
						author: {},
					},
				]),
			],
			[],
		)
		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const result = yield* client.listCommits("42", "octo", "shop", {})
			assert.deepStrictEqual(
				result.commits.map((commit) => [commit.sha, commit.author?.login]),
				[[SHA, undefined]],
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("resolves a ref in an empty repository to no commit", () => {
		const layer = clientLayer(
			[tokenResponse(), new Response('{"message":"Git Repository is empty."}', { status: 409 })],
			[],
		)
		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const commit = yield* client.getCommit("42", "octo", "shop", "main")
			assert.isTrue(Option.isNone(commit))
		}).pipe(Effect.provide(layer))
	})

	it.effect("lists a commit whose tree is git's empty tree as no files", () => {
		const layer = clientLayer(
			[
				tokenResponse(),
				new Response('{"message":"Not Found"}', { status: 404 }),
				jsonResponse({ sha: SHA, tree: { sha: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" } }),
			],
			[],
		)
		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const listing = yield* client.getRecursiveTree("42", "octo", "shop", SHA)
			assert.deepStrictEqual([listing.truncated, listing.tree], [false, []])
		}).pipe(Effect.provide(layer))
	})

	it.effect("still fails a missing tree whose commit has files", () => {
		const layer = clientLayer(
			[
				tokenResponse(),
				new Response('{"message":"Not Found"}', { status: 404 }),
				jsonResponse({ sha: SHA, tree: { sha: "b".repeat(40) } }),
			],
			[],
		)
		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const error = yield* Effect.flip(client.getRecursiveTree("42", "octo", "shop", SHA))
			assert.strictEqual(error.status, 404)
		}).pipe(Effect.provide(layer))
	})

	it.effect("keeps the 404 of a tree in a repository the installation lost", () => {
		const layer = clientLayer(
			[
				tokenResponse(),
				new Response('{"message":"Not Found"}', { status: 404 }),
				new Response('{"message":"Not Found"}', { status: 404 }),
			],
			[],
		)
		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const error = yield* Effect.flip(client.getRecursiveTree("42", "octo", "shop", SHA))
			assert.deepStrictEqual([error.status, error.scope], [404, "repository"])
		}).pipe(Effect.provide(layer))
	})

	it.effect("reads an expired job log as empty", () => {
		const layer = clientLayer([tokenResponse(), logRedirect(), storeError(404, "BlobNotFound")], [])
		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const lines = yield* Stream.runCollect(client.streamJobLog("42", "octo", "shop", "7"))
			assert.deepStrictEqual(lines, [])
		}).pipe(Effect.provide(layer))
	})

	it.effect("retries a job log download while the log store is busy", () => {
		const requests: Array<string> = []
		const layer = clientLayer(
			[
				tokenResponse(),
				logRedirect(),
				storeError(503, "ServerBusy"),
				new Response("line one\nline two\n"),
			],
			requests,
		)
		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const fiber = yield* Effect.forkChild(
				Stream.runCollect(client.streamJobLog("42", "octo", "shop", "7")),
			)
			yield* advance(2)
			const lines = yield* Fiber.join(fiber)
			assert.deepStrictEqual(lines, ["line one", "line two"])
			assert.strictEqual(requests.filter((url) => url.startsWith("https://logs.example")).length, 2)
		}).pipe(Effect.provide(layer))
	})

	it.effect("gives up on a job log download the log store keeps refusing", () => {
		const layer = clientLayer(
			[
				tokenResponse(),
				logRedirect(),
				...Array.from({ length: 4 }, () => storeError(503, "ServerBusy")),
			],
			[],
		)
		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const fiber = yield* Effect.forkChild(
				Effect.flip(Stream.runCollect(client.streamJobLog("42", "octo", "shop", "7"))),
			)
			yield* advance(5)
			const error = yield* Fiber.join(fiber)
			assert.strictEqual(error.status, 503)
		}).pipe(Effect.provide(layer))
	})
})
