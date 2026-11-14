// A fake Tinybird for tests: `/v0/sql` on every regional host, answered from a mutable world by
// which `organization.*` data source the query reads, with every call recorded.
import { DISABLED_ORGANIZATION_FEATURE_FLAGS } from "@maple/domain/organization-feature-flags"
import { Effect, Layer, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import type { TestDb } from "@maple/backend/testing/test-pglite"
import { CostConnectionStore } from "../../CostConnectionStore"
import { fakeCostEnvConfig } from "../fake-cost-env"
import type { ComputeDay, StorageDay, TinybirdIdentity, TransferDay, Workspace } from "./tinybird-cost-api"

export interface FakeTinybird {
	/** The one host the token works on. */
	tokenHost: string
	/** What the token's own host answers a query with when it is not 200, and the error text. */
	ownRefusal: { readonly status: number; readonly error: string } | null
	/** Every host refuses the token's signature. */
	invalidToken: boolean
	/** A host that is down (503). */
	downHost: string | null
	/** A host that never answers, until the request is aborted. */
	hangingHost: string | null
	identity: TinybirdIdentity | null
	workspaces: ReadonlyArray<Workspace>
	compute: ReadonlyArray<ComputeDay>
	storage: ReadonlyArray<StorageDay>
	transfer: ReadonlyArray<TransferDay>
	/** Whether the org is in the `cloudCost` rollout. */
	cloudCost: boolean
	/** Each call as `host` and its SQL. */
	readonly calls: Array<{ readonly host: string; readonly sql: string }>
	readonly authorizations: Array<string | null>
}

export const FAKE_ORG = { organization_id: "0f6a2b9c-1d3e-4f50-8a7b-9c0d1e2f3a4b", organization_name: "Acme" }
export const FAKE_HOST = "https://api.europe-west2.gcp.tinybird.co"

export const makeFakeTinybird = (overrides: Partial<FakeTinybird> = {}): FakeTinybird => ({
	tokenHost: FAKE_HOST,
	ownRefusal: null,
	invalidToken: false,
	downHost: null,
	hangingHost: null,
	identity: FAKE_ORG,
	workspaces: [{ workspace_id: "ws_1", name: "maple_prod", live: 1 }],
	compute: [],
	storage: [],
	transfer: [],
	cloudCost: true,
	calls: [],
	authorizations: [],
	...overrides,
})

const refusal = (status: number, error: string) => Response.json({ error }, { status })

const rows = (data: ReadonlyArray<unknown>) =>
	Response.json({ meta: [], data, rows: data.length, statistics: {} })

const answer = (world: FakeTinybird, sql: string): Response => {
	if (Str.includes("FROM organization.workspaces")(sql)) return rows(world.workspaces)
	if (Str.includes("FROM organization.datasources_storage")(sql)) return rows(world.storage)
	if (Str.includes("FROM organization.data_transfer")(sql)) return rows(world.transfer)
	if (Str.includes("LEFT JOIN")(sql)) return rows(world.compute)
	return rows(world.identity === null ? [] : [world.identity])
}

const fetchStub =
	(world: FakeTinybird): typeof fetch =>
	async (input: string | URL | Request, init?: RequestInit) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		const url = new URL(href)
		const host = url.origin
		const sql = url.searchParams.get("q") ?? ""
		world.calls.push({ host, sql })
		world.authorizations.push(new Headers(init?.headers).get("authorization"))
		if (host === world.downHost) return new Response("unavailable", { status: 503 })
		if (host === world.hangingHost) {
			return Effect.runPromise(Effect.never, { signal: init?.signal ?? undefined })
		}
		if (world.invalidToken) {
			return refusal(
				403,
				"invalid authentication token. Invalid token p.x: Signature verification failed",
			)
		}
		if (host !== world.tokenHost) {
			return refusal(
				403,
				"invalid authentication token. Workspace not found, make sure you use the token host https://api.tinybird.co",
			)
		}
		if (world.ownRefusal !== null) return refusal(world.ownRefusal.status, world.ownRefusal.error)
		return answer(world, sql)
	}

/** Everything the Tinybird cost services need, over the fake and a test database. */
export const fakeTinybirdDeps = (testDb: TestDb, world: FakeTinybird) =>
	Layer.effect(CostConnectionStore, CostConnectionStore.make).pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				FetchHttpClient.layer,
				Layer.succeed(OrganizationFeatureFlagsService, {
					flags: () =>
						Effect.sync(() => ({
							...DISABLED_ORGANIZATION_FEATURE_FLAGS,
							cloudCost: world.cloudCost,
						})),
				}),
				testDb.layer,
				Env.layer,
			),
		),
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchStub(world))),
		Layer.provide(fakeCostEnvConfig()),
	)
