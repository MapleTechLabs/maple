import { assert, describe, it } from "@effect/vitest"
import { generateKeyPairSync } from "node:crypto"
import { ConfigProvider, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import type { VcsInstallation } from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import { fakeGithubHttp } from "@maple/backend/services/integrations/vcs/__tests__/harness"
import { makeVcsSyncIsolateCaches } from "@maple/backend/services/integrations/vcs/vcs-sync-isolate-caches"
import { GithubAppClient } from "@maple/backend/services/integrations/vcs/vendor/github/GithubAppClient"
import { GithubProvider } from "@maple/backend/services/integrations/vcs/vendor/github/GithubProvider"

const privateKey = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey

const env = Env.layer.pipe(
	Layer.provide(
		ConfigProvider.layer(
			ConfigProvider.fromUnknown({
				PORT: "3482",
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

const INSTALLATION = { externalInstallationId: "42" } as VcsInstallation
const REPO = { externalRepoId: "1", owner: "octo", name: "shop" }

// Answers the token mint and any annotations page, recording each path.
const recordingGithub = (paths: Array<string>) =>
	fakeGithubHttp(({ url }) => {
		const path = new URL(url).pathname
		paths.push(path)
		const body = path.endsWith("/access_tokens")
			? { token: "installation-token", expires_at: "2099-01-01T00:00:00Z" }
			: []
		return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
	})

/** Mints `token-<n>` per mint and rejects the first token on every other call, as a revoked one. */
const revokingGithub = (paths: Array<string>, auths: Array<string>, rejection: Response) =>
	fakeGithubHttp(({ url, headers }) => {
		const path = new URL(url).pathname
		paths.push(path)
		if (path.endsWith("/access_tokens")) {
			const token = `token-${mints(paths).length}`
			return Response.json({ token, expires_at: "2099-01-01T00:00:00Z" })
		}
		auths.push(headers["authorization"] ?? "")
		return headers["authorization"] === "token token-1" ? rejection.clone() : Response.json([])
	})

// One batch's provider graph, built fresh the way each queue batch builds VcsSyncLive.
const batchLayer = (paths: Array<string>, github = recordingGithub(paths)) =>
	Layer.effect(GithubProvider, GithubProvider.make).pipe(
		Layer.provide(
			Layer.effect(GithubAppClient, GithubAppClient.make).pipe(
				Layer.provide(github),
				Layer.provide(env),
			),
		),
		Layer.provide(env),
	)

const readAnnotations = GithubProvider.use((provider) =>
	provider.fetchWorkflowJobAnnotations(INSTALLATION, REPO, "555"),
)

const mints = (paths: ReadonlyArray<string>) => paths.filter((path) => path.endsWith("/access_tokens"))

describe("GitHub installation tokens across queue batches", () => {
	it.effect("two batches in one isolate mint one token", () => {
		const paths: Array<string> = []
		return Effect.gen(function* () {
			const caches = yield* makeVcsSyncIsolateCaches
			yield* readAnnotations.pipe(Effect.provide(batchLayer(paths).pipe(Layer.provide(caches))))
			yield* readAnnotations.pipe(Effect.provide(batchLayer(paths).pipe(Layer.provide(caches))))
			assert.lengthOf(mints(paths), 1)
		})
	})

	it.effect("without the isolate caches each batch mints its own", () => {
		const paths: Array<string> = []
		return Effect.gen(function* () {
			yield* readAnnotations.pipe(Effect.provide(batchLayer(paths)))
			yield* readAnnotations.pipe(Effect.provide(batchLayer(paths)))
			assert.lengthOf(mints(paths), 2)
		})
	})

	const rejections = [
		["401", new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })],
		[
			"403 Bad credentials",
			new Response(JSON.stringify({ message: "Bad credentials" }), { status: 403 }),
		],
	] as const
	rejections.forEach(([label, rejection]) =>
		it.effect(`a cached token GitHub rejects with ${label} is evicted, so the next batch mints`, () => {
			const paths: Array<string> = []
			const auths: Array<string> = []
			return Effect.gen(function* () {
				const caches = yield* makeVcsSyncIsolateCaches
				const batch = batchLayer(paths, revokingGithub(paths, auths, rejection)).pipe(
					Layer.provide(caches),
				)
				yield* Effect.exit(readAnnotations.pipe(Effect.provide(batch)))
				yield* Effect.exit(readAnnotations.pipe(Effect.provide(batch)))
				assert.lengthOf(mints(paths), 2)
				assert.deepStrictEqual(auths, ["token token-1", "token token-2"])
			})
		}),
	)

	it.effect("a 403 for a missing permission keeps the cached token", () => {
		const paths: Array<string> = []
		const auths: Array<string> = []
		const forbidden = new Response(
			JSON.stringify({ message: "Resource not accessible by integration" }),
			{
				status: 403,
			},
		)
		return Effect.gen(function* () {
			const caches = yield* makeVcsSyncIsolateCaches
			const batch = batchLayer(paths, revokingGithub(paths, auths, forbidden)).pipe(
				Layer.provide(caches),
			)
			yield* Effect.exit(readAnnotations.pipe(Effect.provide(batch)))
			yield* Effect.exit(readAnnotations.pipe(Effect.provide(batch)))
			assert.lengthOf(mints(paths), 1)
		})
	})

	it.effect(
		"a cached token without actions: read is re-minted after a few minutes, so an accepted permission applies",
		() => {
			const paths: Array<string> = []
			const installation = { accepted: false }
			const github = fakeGithubHttp(({ url }) => {
				paths.push(new URL(url).pathname)
				const actions = installation.accepted ? { actions: "read" } : {}
				return Response.json({
					token: "installation-token",
					expires_at: "2099-01-01T00:00:00Z",
					permissions: { contents: "read", ...actions },
				})
			})
			const canReadActions = GithubAppClient.use((client) => client.canReadActions("42"))
			return Effect.gen(function* () {
				const caches = yield* makeVcsSyncIsolateCaches
				const batch = () =>
					Layer.effect(GithubAppClient, GithubAppClient.make).pipe(
						Layer.provide(github),
						Layer.provide(env),
						Layer.provide(caches),
					)
				assert.isFalse(yield* canReadActions.pipe(Effect.provide(batch())))
				installation.accepted = true
				// A minute later the denial is still served from the isolate cache.
				yield* TestClock.adjust(60_000)
				assert.isFalse(yield* canReadActions.pipe(Effect.provide(batch())))
				assert.lengthOf(mints(paths), 1)
				yield* TestClock.adjust(5 * 60_000)
				assert.isTrue(yield* canReadActions.pipe(Effect.provide(batch())))
				assert.isTrue(yield* canReadActions.pipe(Effect.provide(batch())))
				assert.lengthOf(mints(paths), 2)
			})
		},
	)
})
