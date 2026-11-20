import { assert, describe, it } from "@effect/vitest"
import { vi } from "vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { Effect, Option, Redacted, Schema } from "effect"
import { makeClerkMembershipDirectory } from "./index"

// Clerk's API is faked before any import runs: `user_many` is a custom-role member of 150
// organizations, and the memberships endpoint answers only for the organization and user it is
// filtered by. Every call is recorded.
const clerkApi = vi.hoisted(() => {
	const calls: Array<string> = []
	globalThis.fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(String(input), init)
		const url = new URL(request.url)
		calls.push(`${request.method} ${url.pathname}?${url.searchParams.toString()}`)
		const match = /^\/v1\/organizations\/org_(\d+)\/memberships$/.exec(url.pathname)
		const orgNumber = Number(match?.[1])
		const member =
			orgNumber >= 1 && orgNumber <= 150 && url.searchParams.getAll("user_id").includes("user_many")
		const data = member
			? [
					{
						object: "organization_membership",
						id: `orgmem_${orgNumber}`,
						role: "org:custom",
						permissions: [],
						// Holds Read telemetry (code 36) in every organization.
						public_metadata: { maple_role: { id: "role_abcdefabcdef", permissions: [36] } },
						organization: {
							object: "organization",
							id: `org_${orgNumber}`,
							name: "Acme",
							slug: "acme",
						},
						public_user_data: { user_id: "user_many", identifier: "many@example.com" },
						created_at: 0,
						updated_at: 0,
					},
				]
			: []
		return Response.json({ data, total_count: data.length })
	}
	return { calls }
})

const env = {
	MAPLE_AUTH_MODE: "clerk",
	CLERK_SECRET_KEY: Option.some(Redacted.make("sk_test_directory")),
} as const

const org = Schema.decodeSync(OrgId)
const user = Schema.decodeSync(UserId)

describe("makeClerkMembershipDirectory", () => {
	it.effect("finds a custom role membership in any of the user's organizations", () =>
		Effect.gen(function* () {
			const verify = yield* makeClerkMembershipDirectory(env)
			assert.isDefined(verify)
			const found = yield* verify(user("user_many"), org("org_150"))
			assert.deepStrictEqual(Option.getOrUndefined(found)?.customPermissions, ["telemetry:read"])
			assert.isTrue(Option.isNone(yield* verify(user("user_many"), org("org_151"))))
		}),
	)

	it.effect("keeps each answer for its (user, organization) pair", () =>
		Effect.gen(function* () {
			const verify = yield* makeClerkMembershipDirectory(env)
			assert.isDefined(verify)
			clerkApi.calls.length = 0
			yield* verify(user("user_many"), org("org_7"))
			yield* verify(user("user_many"), org("org_7"))
			yield* verify(user("user_many"), org("org_8"))
			assert.deepStrictEqual(clerkApi.calls, [
				"GET /v1/organizations/org_7/memberships?user_id=user_many&limit=1",
				"GET /v1/organizations/org_8/memberships?user_id=user_many&limit=1",
			])
		}),
	)
})
