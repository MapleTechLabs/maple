// A fake Vercel for tests: `GET /v1/billing/charges` answered from a mutable world as JSONL, with
// every call recorded, and a connected team written the way the integration stores one.
import { VercelConnections } from "@maple/db/tables"
import type { OrgId } from "@maple/domain/http"
import { DISABLED_ORGANIZATION_FEATURE_FLAGS } from "@maple/domain/organization-feature-flags"
import * as PG from "@maple-dev/effect-orm/postgres"
import { ConfigProvider, Effect, Layer, Schema, Array as Arr } from "effect"
import { FetchHttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import { sealSecret, secretKeyringFromEnv } from "@maple/backend/platform/SecretBox"
import { vercelTokenSlot } from "@maple/backend/platform/secret-slots"
import { createIntegrationSource } from "@maple/backend/services/integrations/integration-sources"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import type { TestDb } from "@maple/backend/testing/test-pglite"
import { CostProviderError } from "../../CostProvider"

export interface FakeVercel {
	/** Status of `GET /v1/billing/charges`. */
	chargesStatus: number
	/** The body: charges, served one JSON object per line, or raw text for anything else. */
	charges: ReadonlyArray<Readonly<Record<string, unknown>>> | string
	/** Whether the org is in the `cloudCost` rollout. */
	cloudCost: boolean
	/** Runs when a request arrives, before it is answered: what changes while a read is in flight. */
	onRequest: () => Promise<void>
	readonly urls: Array<string>
	readonly authorizations: Array<string | null>
}

export const makeFakeVercel = (overrides: Partial<FakeVercel> = {}): FakeVercel => ({
	chargesStatus: 200,
	charges: [],
	cloudCost: true,
	onRequest: () => Promise.resolve(),
	urls: [],
	authorizations: [],
	...overrides,
})

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** Charges as Vercel streams them: one JSON object per line. */
export const jsonl = (charges: ReadonlyArray<Readonly<Record<string, unknown>>>): string =>
	Arr.join(
		Arr.map(charges, (charge) => `${encodeJson(charge)}\n`),
		"",
	)

const fetchStub =
	(world: FakeVercel): typeof fetch =>
	async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		world.urls.push(url)
		world.authorizations.push(new Headers(init?.headers).get("authorization"))
		await world.onRequest()
		if (world.chargesStatus !== 200) {
			return Response.json(
				{ error: { code: "refused", message: `status ${world.chargesStatus}` } },
				{ status: world.chargesStatus },
			)
		}
		return new Response(typeof world.charges === "string" ? world.charges : jsonl(world.charges), {
			status: 200,
			headers: { "content-type": "application/jsonl" },
		})
	}

const config = (encryptionKey: string) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: encryptionKey,
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			MAPLE_INGEST_PUBLIC_URL: "https://ingest.test",
		}),
	)

const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64")

/** Everything the Vercel cost services need, over the fake and a test database. */
export const fakeVercelDeps = (
	testDb: TestDb,
	world: FakeVercel,
	/** `MAPLE_INGEST_KEY_ENCRYPTION_KEY`, for a deployment whose secret key is unusable. */
	encryptionKey = ENCRYPTION_KEY,
) =>
	Layer.mergeAll(
		FetchHttpClient.layer,
		Layer.succeed(OrganizationFeatureFlagsService, {
			flags: () =>
				Effect.sync(() => ({ ...DISABLED_ORGANIZATION_FEATURE_FLAGS, cloudCost: world.cloudCost })),
		}),
		testDb.layer,
		Env.layer,
	).pipe(
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchStub(world))),
		Layer.provide(config(encryptionKey)),
	)

export interface FakeVercelConnection {
	readonly orgId: OrgId
	readonly id?: string
	readonly teamId?: string
	readonly teamSlug?: string
	readonly teamName?: string
	readonly token?: string
	/** When the integration's poller found the token rejected. */
	readonly authFailedAt?: number
}

const setupFailed = (message: string) =>
	new CostProviderError({ message, provider: "vercel", reason: "auth", requests: 0 })

/** An org's Vercel connection as the integration saves it, token sealed; answers its id. */
export const connectFakeVercel = (connection: FakeVercelConnection) =>
	Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const keyring = yield* secretKeyringFromEnv(env, setupFailed)
		const { orgId } = connection
		const id = connection.id ?? "0190f2b3-0000-7000-8000-0000000000e1"
		const sealed = yield* sealSecret(
			keyring,
			vercelTokenSlot,
			{ orgId },
			connection.token ?? "vc_token_123",
			setupFailed,
		)
		yield* database.execute((db) =>
			Effect.gen(function* () {
				const sourceId = yield* createIntegrationSource(
					db,
					orgId,
					{ platform: "vercel", name: connection.teamName ?? "Acme" },
					0,
				)
				yield* db.run(
					PG.insertInto(VercelConnections).values({
						id,
						orgId,
						sourceId,
						teamId: connection.teamId ?? "team_1",
						teamSlug: connection.teamSlug ?? "acme",
						teamName: connection.teamName ?? "Acme",
						tokenCiphertext: sealed.ciphertext,
						tokenIv: sealed.iv,
						tokenTag: sealed.tag,
						connectedByUserId: "user_cost",
						projectScope: "all",
						authFailedAt: connection.authFailedAt ?? null,
						createdAt: 0,
						updatedAt: 0,
					}),
				)
			}),
		)
		return id
	}).pipe(Effect.orDie)
