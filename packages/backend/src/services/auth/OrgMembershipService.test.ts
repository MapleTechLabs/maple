import { assert, describe, it } from "@effect/vitest"
import { AuthorizationUnavailableError } from "@maple/domain/http"
import { Effect, Array as Arr } from "effect"
import { type ClerkMembershipRow, collectMemberships } from "./OrgMembershipService"

const row = (id: string, role = "org:member"): ClerkMembershipRow => ({
	organization: { id },
	role,
})

/** A full page is what tells the pager to ask for another one. */
const fullPage = (prefix: string) => Array.from({ length: 100 }, (_, index) => row(`${prefix}_${index}`))

describe("collectMemberships", () => {
	it.effect("stops on the first short page", () =>
		Effect.gen(function* () {
			const offsets: Array<number> = []
			const result = yield* collectMemberships((offset) => {
				offsets.push(offset)
				return Effect.succeed(offset === 0 ? fullPage("org_a") : [row("org_last")])
			})

			assert.deepStrictEqual(offsets, [0, 100])
			assert.strictEqual(result.memberships.length, 101)
			assert.isFalse(result.truncated)
		}),
	)

	/**
	 * The flag that sends a miss to the precise pair lookup. Without it, a user in
	 * more organizations than we page through would be told they are not a member
	 * of one they are in.
	 */
	it.effect("marks a user with more organizations than we page through as truncated", () =>
		Effect.gen(function* () {
			let pages = 0
			const result = yield* collectMemberships(() => {
				pages += 1
				return Effect.succeed(fullPage("org"))
			})

			assert.strictEqual(pages, 5)
			assert.strictEqual(result.memberships.length, 500)
			assert.isTrue(result.truncated)
		}),
	)

	// `OrgId`/`RoleName` are non-empty, trimmed strings; the ids Clerk cannot
	// give us are blank or padded ones.
	it.effect("drops memberships it cannot model rather than failing the request", () =>
		Effect.gen(function* () {
			const result = yield* collectMemberships(() =>
				Effect.succeed([row("org_ok"), row("org_padded", " org:member "), row("")]),
			)

			assert.deepStrictEqual(
				Arr.map(result.memberships, (membership) => membership.orgId),
				["org_ok"],
			)
		}),
	)

	it.effect("keeps a custom role's permission codes from the membership metadata", () =>
		Effect.gen(function* () {
			const result = yield* collectMemberships(() =>
				Effect.succeed([
					{
						organization: { id: "org_custom" },
						role: "org:custom",
						public_metadata: { maple_role: { id: "role_abcdefghijkl", permissions: [10, 36] } },
					},
					row("org_plain"),
				]),
			)

			assert.deepStrictEqual(
				Arr.map(result.memberships, (membership) => membership.permissionCodes),
				[[10, 36], undefined],
			)
		}),
	)

	it.effect("keeps a limited role's namespaces from the membership metadata", () =>
		Effect.gen(function* () {
			const result = yield* collectMemberships(() =>
				Effect.succeed([
					{
						organization: { id: "org_scoped" },
						role: "org:custom",
						public_metadata: {
							maple_role: {
								id: "role_abcdefghijkl",
								permissions: [52],
								namespaces: ["checkout"],
							},
						},
					},
					{
						organization: { id: "org_custom" },
						role: "org:custom",
						public_metadata: { maple_role: { id: "role_abcdefghijkl", permissions: [36] } },
					},
				]),
			)

			assert.deepStrictEqual(
				Arr.map(result.memberships, (membership) => membership.namespaces),
				[["checkout"], undefined],
			)
		}),
	)

	it.effect("a page failure is a failure, never a shorter answer", () =>
		Effect.gen(function* () {
			const result = yield* collectMemberships(() =>
				Effect.fail(new AuthorizationUnavailableError({ message: "Clerk unreachable" })),
			).pipe(Effect.result)

			assert.strictEqual(result._tag, "Failure")
		}),
	)
})
