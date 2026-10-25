import { assert, describe, it } from "@effect/vitest"
import { generateKeyPairSync } from "node:crypto"
import { ConfigProvider, Effect, Layer } from "effect"
import { Env } from "@maple/backend/platform/Env"
import {
	COMMIT_PAGES_PER_INVOCATION,
	GithubAppClient,
} from "@maple/backend/services/integrations/vcs/vendor/github/GithubAppClient"
import { VcsRepositoryBlockedError, VcsRepoUnavailableError } from "@maple/domain/http"
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

const commit = (index: number) => ({
	sha: index.toString(16).padStart(40, "0"),
	html_url: `https://github.com/octo/shop/commit/${index}`,
	commit: { message: `commit ${index}`, author: null },
	author: null,
})

describe("GithubAppClient paging", () => {
	it.effect("keeps the commits already fetched when a later page is rate limited", () => {
		const requests: Array<string> = []
		const layer = clientLayer(
			[
				tokenResponse(),
				jsonResponse(Array.from({ length: 100 }, (_, index) => commit(index))),
				new Response("slow down", { status: 429, headers: { "retry-after": "120" } }),
			],
			requests,
		)

		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const result = yield* client.listCommits("42", "octo", "shop", {})
			assert.strictEqual(result.complete, false)
			assert.strictEqual(result.commits.length, 100)
			if (!result.complete) {
				assert.strictEqual(result.reason, "rate-limited")
				assert.strictEqual(result.reason === "rate-limited" && result.retryAfterSeconds, 120)
			}
			assert.include(requests[2], "page=2")
		}).pipe(Effect.provide(layer))
	})

	it.effect("stops paging commits at the first short page", () => {
		const requests: Array<string> = []
		const layer = clientLayer(
			[
				tokenResponse(),
				jsonResponse(Array.from({ length: 100 }, (_, index) => commit(index))),
				jsonResponse([commit(100)]),
			],
			requests,
		)

		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const result = yield* client.listCommits("42", "octo", "shop", {})
			assert.strictEqual(result.complete, true)
			assert.strictEqual(result.commits.length, 101)
			assert.strictEqual(requests.length, 3)
		}).pipe(Effect.provide(layer))
	})

	it.effect("stops at the page budget after a full final page and asks for a continuation", () => {
		const requests: Array<string> = []
		const fullPage = (page: number) =>
			jsonResponse(Array.from({ length: 100 }, (_, index) => commit(page * 100 + index)))
		const layer = clientLayer(
			[
				tokenResponse(),
				...Array.from({ length: COMMIT_PAGES_PER_INVOCATION }, (_, page) => fullPage(page)),
				fullPage(COMMIT_PAGES_PER_INVOCATION),
			],
			requests,
		)

		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const result = yield* client.listCommits("42", "octo", "shop", {})
			assert.strictEqual(result.complete, false)
			assert.strictEqual(!result.complete && result.reason, "page-budget")
			assert.strictEqual(result.commits.length, 100 * COMMIT_PAGES_PER_INVOCATION)
			// One token mint plus exactly the budgeted pages: the page after the budget is never requested.
			assert.strictEqual(requests.length, 1 + COMMIT_PAGES_PER_INVOCATION)
		}).pipe(Effect.provide(layer))
	})

	it.effect("pages comments until the App's marked comment, then edits it", () => {
		const requests: Array<string> = []
		const unrelated = Array.from({ length: 100 }, (_, index) => ({
			id: index + 1,
			html_url: `https://github.com/octo/shop/pull/1#issuecomment-${index + 1}`,
			body: "<!-- maple-summary --> quoted by a person",
			performed_via_github_app: null,
		}))
		const ours = {
			id: 500,
			html_url: "https://github.com/octo/shop/pull/1#issuecomment-500",
			body: "<!-- maple-summary --> old",
			performed_via_github_app: { id: 123456 },
		}
		const layer = clientLayer(
			[
				tokenResponse(),
				jsonResponse(unrelated),
				jsonResponse([ours]),
				jsonResponse({ ...ours, body: "<!-- maple-summary --> new" }),
			],
			requests,
		)

		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			yield* client.upsertIssueComment("42", "octo", "shop", 1, "<!-- maple-summary -->", "new")
			assert.strictEqual(requests.length, 4)
			assert.include(requests[2], "page=2")
			assert.include(requests[3], "/issues/comments/500")
		}).pipe(Effect.provide(layer))
	})

	it.effect("deletes the App's marked comment when the body asks for it", () => {
		const requests: Array<string> = []
		const ours = {
			id: 500,
			html_url: "https://github.com/octo/shop/pull/1#issuecomment-500",
			body: "<!-- maple-summary --> old",
			performed_via_github_app: { id: 123456 },
		}
		const layer = clientLayer(
			[tokenResponse(), jsonResponse([ours]), new Response(null, { status: 204 })],
			requests,
		)

		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const result = yield* client.upsertIssueComment(
				"42",
				"octo",
				"shop",
				1,
				"<!-- maple-summary -->",
				() => null,
			)
			assert.isUndefined(result)
			assert.strictEqual(requests.length, 3)
			assert.include(requests[2], "/issues/comments/500")
		}).pipe(Effect.provide(layer))
	})
})

// A gone or blocked repo is an answer the sync records. The listing fails with the anticipated
// domain error so its span records Ok instead of opening an error issue per repo and poll.
describe("GithubAppClient repository listings", () => {
	it.effect("fails a legally blocked repository's branch listing as VcsRepositoryBlockedError", () => {
		const layer = clientLayer(
			[
				tokenResponse(),
				new Response(
					JSON.stringify({ message: "Repository access blocked", block: { reason: "dmca" } }),
					{
						status: 451,
					},
				),
			],
			[],
		)

		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const error = yield* Effect.flip(client.listBranches("42", "octo", "shop"))
			assert.instanceOf(error, VcsRepositoryBlockedError)
			assert.strictEqual(error instanceof VcsRepositoryBlockedError && error.status, 451)
		}).pipe(Effect.provide(layer))
	})

	it.effect("fails a deleted repository's commit listing as VcsRepoUnavailableError", () => {
		const layer = clientLayer(
			[tokenResponse(), new Response('{"message":"Not Found"}', { status: 404 })],
			[],
		)

		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const error = yield* Effect.flip(client.listCommits("42", "octo", "shop", {}))
			assert.instanceOf(error, VcsRepoUnavailableError)
		}).pipe(Effect.provide(layer))
	})

	it.effect("keeps an upstream 5xx a GithubAppError the provider can retry", () => {
		const layer = clientLayer([tokenResponse(), new Response("boom", { status: 502 })], [])

		return Effect.gen(function* () {
			const client = yield* GithubAppClient
			const error = yield* Effect.flip(client.listBranches("42", "octo", "shop"))
			assert.strictEqual(error._tag, "@maple/backend/vcs/GithubAppError")
		}).pipe(Effect.provide(layer))
	})
})
