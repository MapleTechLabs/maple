import { assert, describe, expect, it } from "@effect/vitest"
import { Array as Arr, Effect, Schema } from "effect"
import * as Policy from "./index"

class Forbidden extends Schema.TaggedError<Forbidden>()("@maple/test/Forbidden", {
	message: Schema.String,
}) {}

describe("Policy.can", () => {
	it("lets an engineer change technical setup but not billing or members", () => {
		const engineer = ["org:engineer"]
		expect(Policy.can(engineer, "integrations:manage")).toBe(true)
		expect(Policy.can(engineer, "code_review:configure")).toBe(true)
		expect(Policy.can(engineer, "billing:manage")).toBe(false)
		expect(Policy.can(engineer, "members:manage")).toBe(false)
		// Triage findings, but not spend the audit budget.
		expect(Policy.can(engineer, "security:manage")).toBe(true)
		expect(Policy.can(engineer, "security_audit:run")).toBe(false)
	})

	it("gives admins and root everything an engineer has and more", () => {
		for (const roles of [["org:admin"], ["root"]]) {
			expect(Policy.can(roles, "integrations:manage")).toBe(true)
			expect(Policy.can(roles, "billing:manage")).toBe(true)
		}
	})

	it("reads members, unknown Clerk roles and no roles as member", () => {
		for (const roles of [["org:member"], ["org:billing"], []]) {
			expect(Policy.can(roles, "alerts:manage")).toBe(false)
		}
	})

	it("uses the highest of several roles", () => {
		expect(Policy.can(["org:member", "org:admin"], "billing:manage")).toBe(true)
	})
})

describe("Policy.check", () => {
	it.effect("passes when the roles hold the permission", () =>
		Policy.check(
			["org:engineer"],
			"alerts:manage",
			(denial) => new Forbidden({ message: denial.message }),
		),
	)

	it.effect("fails with the caller's error and a message naming who may", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				Policy.check(
					["org:member"],
					"integrations:manage",
					(denial) => new Forbidden({ message: denial.message }),
				),
			)
			assert.instanceOf(error, Forbidden)
			expect(error.message).toBe("Only org admins and engineers can manage integrations.")
		}),
	)

	it.effect("names only admins for an admin permission", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				Policy.check(
					["org:engineer"],
					"billing:manage",
					(denial) => new Forbidden({ message: denial.message }),
				),
			)
			expect(error.message).toBe("Only org admins can manage billing.")
		}),
	)
})

describe("Policy.grantsOf", () => {
	it("lists what an engineer may do, which a page reads back with has", () => {
		const grants = Policy.grantsOf(["org:engineer"])
		expect(Policy.has(grants, "status_pages:edit")).toBe(true)
		expect(Policy.has(grants, "status_pages:break_glass")).toBe(false)
	})

	it("survives a round trip through the page-model schema", () => {
		const grants = Policy.grantsOf(["org:admin"])
		const decoded = Schema.decodeSync(Schema.Array(Policy.PermissionName))(grants)
		expect(Policy.has(decoded, "warehouse:manage")).toBe(true)
	})
})

describe("roleOf", () => {
	it("maps the Clerk keys the Members page assigns", () => {
		expect(Arr.map(Policy.assignableRoles, (entry) => Policy.roleOf(entry.clerkKey))).toEqual([
			"member",
			"engineer",
			"admin",
		])
	})
})
