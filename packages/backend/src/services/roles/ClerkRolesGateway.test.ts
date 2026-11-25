import { assert, describe, it } from "@effect/vitest"
import { vi } from "vitest"
import { CreateRoleRequest, OrgId, RolesUnavailableError, UserId } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { MembershipRevocationService } from "@maple/backend/services/auth/MembershipRevocationService"
import { ClerkRolesGateway } from "./ClerkRolesGateway"
import { RolesService } from "./RolesService"
import { RoleWriteLock } from "./RoleWriteLock"

// Clerk's API is faked before any import runs: the organization answers with `publicMetadata`, its
// memberships with `memberships`, and every call is recorded.
const clerkApi = vi.hoisted(() => {
	const calls: Array<string> = []
	const state = { publicMetadata: {}, memberships: [] as Array<unknown>, calls }
	globalThis.fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(String(input), init)
		const url = new URL(request.url)
		state.calls.push(`${request.method} ${url.pathname}`)
		if (request.method === "GET" && url.pathname === "/v1/organizations/org_roles") {
			return Response.json({
				object: "organization",
				id: "org_roles",
				name: "Roles",
				slug: "roles",
				public_metadata: state.publicMetadata,
				private_metadata: {},
				created_at: 0,
				updated_at: 0,
			})
		}
		if (request.method === "GET" && url.pathname === "/v1/organizations/org_roles/memberships") {
			return Response.json({ data: state.memberships, total_count: state.memberships.length })
		}
		return Response.json({ errors: [{ code: "resource_not_found" }] }, { status: 404 })
	}
	return state
})

const ORG = Schema.decodeSync(OrgId)("org_roles")
const tenant = { orgId: ORG, userId: Schema.decodeSync(UserId)("user_admin") }

const clerkMode = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		TINYBIRD_HOST: "https://api.tinybird.co",
		TINYBIRD_TOKEN: "test-token",
		TINYBIRD_SIGNING_KEY: "test-signing-key",
		TINYBIRD_WORKSPACE_ID: "test-workspace",
		MAPLE_AUTH_MODE: "clerk",
		CLERK_SECRET_KEY: "sk_test_roles",
		MAPLE_DEFAULT_ORG_ID: "default",
		MAPLE_APP_BASE_URL: "https://app.example.com",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	}),
)

const gateway = ClerkRolesGateway.layer.pipe(Layer.provide(Env.layer.pipe(Layer.provide(clerkMode))))
const layer = Layer.effect(RolesService, RolesService.make).pipe(
	Layer.provide(
		Layer.mergeAll(
			gateway,
			Layer.mock(MembershipRevocationService)({}),
			Layer.succeed(RoleWriteLock, { withLock: (_orgId, effect) => effect }),
		),
	),
)

describe("ClerkRolesGateway", () => {
	it.effect("reads the definitions beside the organization's other metadata", () =>
		Effect.gen(function* () {
			const stored = {
				version: 3,
				roles: [
					{
						id: "role_abcdefabcdef",
						name: "On-call",
						description: "",
						permissions: [36],
						createdAt: 1,
						updatedAt: 1,
					},
				],
			}
			clerkApi.publicMetadata = { region: "eu", [Policy.ORG_ROLES_METADATA_KEY]: stored }
			const clerk = yield* ClerkRolesGateway
			assert.deepStrictEqual(yield* clerk.customRoles(ORG), stored)
		}).pipe(Effect.provide(gateway)),
	)

	it.effect("reads each membership's role, metadata and profile", () =>
		Effect.gen(function* () {
			const metadata = {
				[Policy.MEMBERSHIP_ROLE_METADATA_KEY]: { id: "role_abcdefabcdef", permissions: [36] },
			}
			const membership = (userId: string, role: string, firstName: string | null) => ({
				object: "organization_membership",
				id: `orgmem_${userId}`,
				role,
				permissions: [],
				public_metadata: role === "org:custom" ? metadata : {},
				organization: { object: "organization", id: "org_roles", name: "Roles", slug: "roles" },
				public_user_data: {
					user_id: userId,
					first_name: firstName,
					last_name: "Doe",
					profile_image_url: null,
					image_url: `https://img.example/${userId}`,
					has_image: true,
					identifier: `${userId}@example.com`,
				},
				created_at: 0,
				updated_at: 0,
			})
			clerkApi.memberships = [
				membership("user_jane", "org:custom", "Jane"),
				membership("user_john", "org:member", null),
			]
			const clerk = yield* ClerkRolesGateway
			assert.deepStrictEqual(yield* clerk.memberships(ORG), [
				{
					userId: "user_jane",
					role: "org:custom",
					metadata,
					name: "Jane Doe",
					identifier: "user_jane@example.com",
					imageUrl: "https://img.example/user_jane",
				},
				{
					userId: "user_john",
					role: "org:member",
					metadata: {},
					name: "Doe",
					identifier: "user_john@example.com",
					imageUrl: "https://img.example/user_john",
				},
			])
		}).pipe(Effect.provide(gateway)),
	)

	it.effect("refuses to edit roles over definitions it cannot read, and writes nothing", () =>
		Effect.gen(function* () {
			clerkApi.publicMetadata = {
				region: "eu",
				[Policy.ORG_ROLES_METADATA_KEY]: { roles: [{ id: 1 }] },
			}
			clerkApi.calls.length = 0
			const roles = yield* RolesService
			const created = yield* Effect.flip(
				roles.create(
					tenant,
					new CreateRoleRequest({ name: "On-call", permissions: ["telemetry:read"] }),
				),
			)
			assert.instanceOf(created, RolesUnavailableError)
			assert.deepStrictEqual(clerkApi.calls, ["GET /v1/organizations/org_roles"])
		}).pipe(Effect.provide(layer)),
	)
})
