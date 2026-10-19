import { assert, describe, it } from "@effect/vitest"
import { generateKeyPairSync } from "node:crypto"
import { ConfigProvider, Effect, Layer } from "effect"
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

// One batch's provider graph, built fresh the way each queue batch builds VcsSyncLive.
const batchLayer = (paths: Array<string>) =>
	Layer.effect(GithubProvider, GithubProvider.make).pipe(
		Layer.provide(
			Layer.effect(GithubAppClient, GithubAppClient.make).pipe(
				Layer.provide(recordingGithub(paths)),
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
})
