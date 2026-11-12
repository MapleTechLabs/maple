// A fake OpenRouter for tests: `GET /key` and `GET /activity` answered from a mutable world, with
// every call recorded.
import { DISABLED_ORGANIZATION_FEATURE_FLAGS } from "@maple/domain/organization-feature-flags"
import { Effect, Layer, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import type { TestDb } from "@maple/backend/testing/test-pglite"
import type { ActivityItem } from "../../../org/openrouter-api"
import { fakeCostEnvConfig } from "../fake-cost-env"

export interface FakeOpenRouter {
	/** Status of `GET /key`. */
	keyStatus: number
	/** What `GET /key` says the key is. */
	isManagementKey: boolean
	keyLabel: string
	/** The account `GET /key` names: an organization's id, or null for a personal account. */
	organizationId: string | null
	/** The user who made the key, which is the account when there is no organization. */
	creatorUserId: string
	/** Status of `GET /activity`. */
	activityStatus: number
	/** The key is scoped to one workspace: asked for another, it answers 403 where an account's key answers 404. */
	workspaceScoped: boolean
	/** The body of `GET /activity`: rows, or raw text for a malformed answer. */
	activity: ReadonlyArray<typeof ActivityItem.Encoded> | string
	/** Whether the org is in the `cloudCost` rollout. */
	cloudCost: boolean
	readonly urls: Array<string>
	readonly authorizations: Array<string | null>
}

export const makeFakeOpenRouter = (overrides: Partial<FakeOpenRouter> = {}): FakeOpenRouter => ({
	keyStatus: 200,
	isManagementKey: true,
	keyLabel: "sk-or-v1-abc...123",
	organizationId: null,
	creatorUserId: "user_account_a",
	activityStatus: 200,
	workspaceScoped: false,
	activity: [],
	cloudCost: true,
	urls: [],
	authorizations: [],
	...overrides,
})

const refused = (status: number) =>
	Response.json({ error: { code: status, message: `status ${status}` } }, { status })

const fetchStub =
	(world: FakeOpenRouter): typeof fetch =>
	async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		world.urls.push(url)
		world.authorizations.push(new Headers(init?.headers).get("authorization"))
		if (Str.endsWith("/key")(url)) {
			return world.keyStatus === 200
				? Response.json({
						data: {
							label: world.keyLabel,
							is_management_key: world.isManagementKey,
							is_provisioning_key: false,
							organization_id: world.organizationId,
							creator_user_id: world.creatorUserId,
						},
					})
				: refused(world.keyStatus)
		}
		if (world.activityStatus !== 200) return refused(world.activityStatus)
		if (Str.includes("workspace_id=")(url)) return refused(world.workspaceScoped ? 403 : 404)
		return typeof world.activity === "string"
			? new Response(world.activity, { status: 200 })
			: Response.json({ data: world.activity })
	}

/** Everything the OpenRouter cost services need, over the fake and a test database. */
export const fakeOpenRouterDeps = (
	testDb: TestDb,
	world: FakeOpenRouter,
	/** `MAPLE_INGEST_KEY_ENCRYPTION_KEY`, for a deployment whose secret key is unusable. */
	encryptionKey?: string,
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
		Layer.provide(fakeCostEnvConfig(encryptionKey)),
	)
