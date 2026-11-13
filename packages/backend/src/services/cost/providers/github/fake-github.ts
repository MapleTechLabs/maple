// A fake GitHub for tests: the installation token mint and the billing usage report answered from
// a mutable world, with every call recorded. Installations are rows in the test database.
import { DISABLED_ORGANIZATION_FEATURE_FLAGS } from "@maple/domain/organization-feature-flags"
import { Array as Arr, Effect, Layer, Schema, String as Str } from "effect"
import { fakeGithubHttp, registryOverHttp } from "@maple/backend/services/integrations/vcs/__tests__/harness"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { insertTestSource, type TestDb } from "@maple/backend/testing/test-pglite"
import type { UsageItem } from "./normalize"

export interface FakeGithub {
	/** Status of the installation token mint. */
	mintStatus: number
	/** What the minted token says the installation accepted; null leaves the list out. */
	permissions: Readonly<Record<string, string>> | null
	/** Status of the billing usage report. */
	usageStatus: number
	/** The body of a refused report. */
	refusal: string
	/** `authorization` values GitHub answers 401 to, as a token revoked since it was minted. */
	rejected: ReadonlyArray<string>
	/** `retry-after` seconds on a 403, the way GitHub's secondary rate limit answers. */
	retryAfter: number | null
	/** The usage lines, whatever month is asked for, or raw text for a malformed answer. */
	usage: ReadonlyArray<typeof UsageItem.Encoded> | string
	/** Whether the org is in the `cloudCost` rollout. */
	cloudCost: boolean
	/** Path and query of every request, in order. */
	readonly paths: Array<string>
	/** The `authorization` header of every billing request. */
	readonly authorizations: Array<string | undefined>
}

export const makeFakeGithub = (overrides: Partial<FakeGithub> = {}): FakeGithub => ({
	mintStatus: 200,
	permissions: { organization_administration: "read", metadata: "read" },
	usageStatus: 200,
	refusal: "Not Found",
	rejected: [],
	retryAfter: null,
	usage: [],
	cloudCost: true,
	paths: [],
	authorizations: [],
	...overrides,
})

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const json = (body: unknown, init?: ResponseInit) =>
	new Response(encodeJson(body), {
		...init,
		headers: { "content-type": "application/json", ...init?.headers },
	})

/** The tokens minted so far are `token-1`, `token-2`, in order. */
const mintsOf = (world: FakeGithub) =>
	Arr.filter(world.paths, (path) => Str.endsWith("/access_tokens")(path)).length

const http = (world: FakeGithub) =>
	fakeGithubHttp(({ url, headers }) => {
		const parsed = new URL(url)
		world.paths.push(`${parsed.pathname}${parsed.search}`)
		if (Str.endsWith("/access_tokens")(parsed.pathname)) {
			if (world.mintStatus !== 200) return json({ message: "Not Found" }, { status: world.mintStatus })
			const token = { token: `token-${mintsOf(world)}`, expires_at: "2099-01-01T00:00:00Z" }
			return json(world.permissions === null ? token : { ...token, permissions: world.permissions })
		}
		world.authorizations.push(headers["authorization"])
		if (Arr.contains(world.rejected, headers["authorization"] ?? "")) {
			return json({ message: "Bad credentials" }, { status: 401 })
		}
		if (world.usageStatus !== 200) {
			return json(
				{ message: world.refusal },
				{
					status: world.usageStatus,
					headers: world.retryAfter === null ? {} : { "retry-after": `${world.retryAfter}` },
				},
			)
		}
		return typeof world.usage === "string"
			? new Response(world.usage, { status: 200 })
			: json({ usageItems: world.usage })
	})

/** Everything the GitHub cost services need, over the fake and a test database. */
export const fakeGithubDeps = (testDb: TestDb, world: FakeGithub) =>
	Layer.mergeAll(
		registryOverHttp(http(world)),
		Layer.succeed(OrganizationFeatureFlagsService, {
			flags: () =>
				Effect.sync(() => ({ ...DISABLED_ORGANIZATION_FEATURE_FLAGS, cloudCost: world.cloudCost })),
		}),
		testDb.layer,
	)

interface FakeInstallation {
	readonly id: string
	readonly orgId: string
	readonly login: string
	readonly externalId: string
	readonly accountType?: "organization" | "user"
	readonly status?: "active" | "suspended" | "disconnected"
}

/** A GitHub App installation row, with the source row it sends as. */
export const insertInstallation = (testDb: TestDb, installation: FakeInstallation) =>
	Effect.promise(async () => {
		const sourceId = await insertTestSource(testDb, { orgId: installation.orgId, platform: "github" })
		await testDb.pglite.query(
			`INSERT INTO vcs_installations
			   (id, org_id, source_id, provider, external_installation_id, account_login, account_type,
			    external_account_id, status, installed_by_user_id, created_at, updated_at)
			 VALUES ($1, $2, $3, 'github', $4, $5, $6, $4, $7, 'user_cost', now(), now())`,
			[
				installation.id,
				installation.orgId,
				sourceId,
				installation.externalId,
				installation.login,
				installation.accountType ?? "organization",
				installation.status ?? "active",
			],
		)
	})
