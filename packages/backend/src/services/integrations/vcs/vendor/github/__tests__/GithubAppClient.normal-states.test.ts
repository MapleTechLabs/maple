import { assert, describe, it } from "@effect/vitest"
import { generateKeyPairSync } from "node:crypto"
import {
	ConfigProvider,
	Effect,
	Fiber,
	Layer,
	Option,
	Stream,
	Array as Arr,
	Record as Rec,
	String as Str,
} from "effect"
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

const SHA = Str.repeat(40)("a")

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
				Arr.map(result.commits, (commit) => [commit.sha, commit.author?.login]),
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

	it.effect("fails a commit lookup on a 409 that is not an empty repository", () => {
		const layer = clientLayer(
			[tokenResponse(), new Response('{"message":"Git Repository is unavailable."}', { status: 409 })],
			[],
		)
		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const error = yield* Effect.flip(client.getCommit("42", "octo", "shop", "main"))
			assert.deepStrictEqual([error.status, error.scope], [409, "repository"])
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
				jsonResponse({ sha: SHA, tree: { sha: Str.repeat(40)("b") } }),
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

	describe("a tree too large for one recursive read", () => {
		const blob = (path: string, sha: string) => ({ path, type: "blob", sha, size: 10 })
		const tree = (path: string, sha: string) => ({ path, type: "tree", sha })
		// root/ { README.md, apps/ { web/ { bun.lock } }, packages/ { db/ { package.json } } }
		// The root and `apps` are truncated recursively; `apps/web` and `packages` are not.
		type Listings = Record<string, { truncated: boolean; tree: ReadonlyArray<unknown> }>
		const listings: Listings = {
			"root?recursive=1": { truncated: true, tree: [blob("README.md", "r1")] },
			root: {
				truncated: false,
				tree: [blob("README.md", "r1"), tree("apps", "apps"), tree("packages", "pkgs")],
			},
			"apps?recursive=1": { truncated: true, tree: [] },
			apps: { truncated: false, tree: [tree("web", "web")] },
			"web?recursive=1": { truncated: false, tree: [blob("bun.lock", "l1")] },
			"pkgs?recursive=1": {
				truncated: false,
				tree: [tree("db", "db"), blob("db/package.json", "p1")],
			},
		}
		const routedLayer = (served: Listings, treeReads: Array<string> = []) => {
			const http = fakeGithubHttp(({ url }) => {
				if (Str.endsWith("/access_tokens")(url)) return tokenResponse()
				treeReads.push(url)
				const key = Option.getOrUndefined(
					Option.map(Arr.get(Str.split("/git/trees/")(url), 1), Str.replace(SHA, "root")),
				)
				const listing = key === undefined ? undefined : served[key]
				return listing === undefined
					? new Response("unexpected request", { status: 500 })
					: jsonResponse({
							sha: key !== undefined && Str.startsWith("root")(key) ? "root" : key,
							...listing,
						})
			})
			return Layer.effect(GithubAppClient, GithubAppClient.make).pipe(
				Layer.provide(http),
				Layer.provide(env),
			)
		}

		it.effect("lists every file by reading its subtrees", () => {
			return Effect.gen(function* () {
				const client = yield* GithubAppClient
				const listing = yield* client.getRecursiveTree("42", "octo", "shop", SHA)
				const blobs = Arr.map(
					Arr.filter(listing.tree, (entry) => entry.type === "blob"),
					(entry) => entry.path,
				)
				assert.isFalse(listing.truncated)
				assert.deepStrictEqual(blobs.sort(), [
					"README.md",
					"apps/web/bun.lock",
					"packages/db/package.json",
				])
			}).pipe(Effect.provide(routedLayer(listings)))
		})

		it.effect("stays truncated when a subtree cannot be listed whole", () => {
			const served = { ...listings, apps: { truncated: true, tree: [tree("web", "web")] } }
			return Effect.gen(function* () {
				const client = yield* GithubAppClient
				const listing = yield* client.getRecursiveTree("42", "octo", "shop", SHA)
				assert.isTrue(listing.truncated)
			}).pipe(Effect.provide(routedLayer(served)))
		})

		/** A truncated root whose direct entries are `dirs`, each listing whole as `subtree(i)`. */
		const wideRoot = (dirs: number, subtree: (i: number) => ReadonlyArray<unknown>): Listings => ({
			"root?recursive=1": { truncated: true, tree: [] },
			root: { truncated: false, tree: Arr.makeBy(dirs, (i) => tree(`d${i}`, `d${i}`)) },
			...Rec.fromEntries(
				Arr.makeBy(
					dirs,
					(i) => [`d${i}?recursive=1`, { truncated: false, tree: subtree(i) }] as const,
				),
			),
		})

		it.effect("stops at 400 reads and reports the listing truncated", () => {
			const treeReads: Array<string> = []
			return Effect.gen(function* () {
				const client = yield* GithubAppClient
				const listing = yield* client.getRecursiveTree("42", "octo", "shop", SHA)
				// The first recursive read, then the walk's 400: the root level and 399 of 401 subtrees.
				assert.deepStrictEqual([listing.truncated, treeReads.length], [true, 401])
			}).pipe(
				Effect.provide(
					routedLayer(
						wideRoot(401, (i) => [blob("f", `f${i}`)]),
						treeReads,
					),
				),
			)
		})

		it.effect("reports the listing truncated past 150,000 held entries", () =>
			Effect.gen(function* () {
				const client = yield* GithubAppClient
				const listing = yield* client.getRecursiveTree("42", "octo", "shop", SHA)
				assert.isTrue(listing.truncated)
			}).pipe(
				Effect.provide(
					routedLayer(
						wideRoot(2, (i) =>
							i === 0 ? Arr.makeBy(150_001, (n) => blob(`f${n}`, `s${n}`)) : [blob("f", "s")],
						),
					),
				),
			),
		)
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
			assert.strictEqual(Arr.filter(requests, (url) => new URL(url).host === "logs.example").length, 2)
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
