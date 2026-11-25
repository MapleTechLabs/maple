import { assert, describe, expect, it } from "@effect/vitest"
import { Array as Arr, Effect, Option, Record as Rec, Schema } from "effect"
import * as Policy from "./index"

class Forbidden extends Schema.TaggedError<Forbidden>()("@maple/test/Forbidden", {
	message: Schema.String,
}) {}

const presetOf = (clerkKey: string) => Policy.grantsOf([clerkKey])

describe("Policy.grantsOf", () => {
	it("lets an engineer change technical setup but not billing, members or roles", () => {
		const engineer = presetOf("org:engineer")
		expect(Policy.can(engineer, "integrations:manage")).toBe(true)
		expect(Policy.can(engineer, "oncall:manage")).toBe(true)
		expect(Policy.can(engineer, "billing:manage")).toBe(false)
		expect(Policy.can(engineer, "members:manage")).toBe(false)
		expect(Policy.can(engineer, "roles:manage")).toBe(false)
		expect(Policy.can(engineer, "security:manage")).toBe(true)
		expect(Policy.can(engineer, "security_audit:run")).toBe(false)
	})

	it("gives admins and root every permission", () => {
		expect(presetOf("org:admin")).toEqual(Policy.allPermissions)
		expect(presetOf("root")).toEqual(Policy.allPermissions)
	})

	it("gives an analyst read access and nothing that changes the organization", () => {
		expect(presetOf("org:analyst")).toEqual([
			"telemetry:read",
			"query:sql",
			"dashboards:edit",
			"dashboards:share",
			"ai:ask",
			"devices:connect",
		])
	})

	it("gives a member read access, everyday work and incident response", () => {
		const member = presetOf("org:member")
		expect(member).toHaveLength(16)
		expect(Policy.can(member, "telemetry:read")).toBe(true)
		expect(Policy.can(member, "ai:act")).toBe(true)
		expect(Policy.can(member, "incidents:respond")).toBe(true)
		expect(Policy.can(member, "alerts:manage")).toBe(false)
	})

	it("reads a tenant with no roles as a member, and a Clerk role it does not know as an analyst", () => {
		expect(Policy.grantsOf([])).toEqual(presetOf("org:member"))
		expect(presetOf("org:billing")).toEqual(presetOf("org:analyst"))
	})

	it("holds nothing for org:custom without permissions on the membership", () => {
		expect(Policy.grantsOf([Policy.CUSTOM_ROLE_CLERK_KEY])).toEqual([])
	})

	it("holds the membership's permissions for org:custom, with what they imply", () => {
		expect(
			Policy.grantsOf([Policy.CUSTOM_ROLE_CLERK_KEY], ["alerts:manage", "ingest_keys:roll"]),
		).toEqual(["telemetry:read", "alerts:manage", "ingest_keys:view", "ingest_keys:roll"])
		expect(Policy.grantsOf([Policy.CUSTOM_ROLE_CLERK_KEY], ["billing:manage"])).toEqual([
			"billing:manage",
		])
	})

	it("holds what any of several roles holds", () => {
		expect(Policy.can(Policy.grantsOf(["org:member", "org:admin"]), "billing:manage")).toBe(true)
	})

	it("holds what each built-in role's permissions imply", () => {
		for (const entry of Policy.builtInRoles) {
			expect(Policy.withImplied(entry.permissions)).toEqual(presetOf(entry.clerkKey))
		}
	})

	it("nests the built-in roles: each holds everything the one below it holds", () => {
		const presets = Arr.map(Policy.builtInRoles, (entry) => presetOf(entry.clerkKey))
		for (const [lower, upper] of Arr.zip(presets.slice(0, -1), presets.slice(1))) {
			expect(Policy.exceeds(lower, upper)).toBe(false)
			expect(Policy.exceeds(upper, lower)).toBe(true)
		}
	})
})

describe("Policy.check", () => {
	it.effect("passes when the grants hold the permission", () =>
		Policy.check(
			presetOf("org:engineer"),
			"alerts:manage",
			(denial) => new Forbidden({ message: denial.message }),
		),
	)

	it.effect("fails with the caller's error and a message naming the built-in roles that have it", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				Policy.check(
					presetOf("org:member"),
					"integrations:manage",
					(denial) => new Forbidden({ message: denial.message }),
				),
			)
			assert.instanceOf(error, Forbidden)
			expect(error.message).toBe(
				"You need Manage integrations to manage integrations. Admin and Engineer have it.",
			)
		}),
	)

	it.effect("says every built-in role has a read permission", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				Policy.check([], "telemetry:read", (denial) => new Forbidden({ message: denial.message })),
			)
			expect(error.message).toBe(
				"You need Read telemetry to read telemetry. Every built-in role has it.",
			)
		}),
	)

	it("names a single holder in the singular", () => {
		expect(Policy.denialFor("billing:manage").message).toBe(
			"You need Manage billing to manage billing. Admin has it.",
		)
	})
})

describe("Policy.exceeds", () => {
	it("is true only when the pinned grants hold something the current ones lack", () => {
		expect(Policy.exceeds(["alerts:manage"], ["alerts:manage", "billing:manage"])).toBe(false)
		expect(Policy.exceeds(["alerts:manage", "billing:manage"], ["alerts:manage"])).toBe(true)
		expect(Policy.exceeds([], [])).toBe(false)
	})
})

describe("permission codes", () => {
	it("gives every permission its own code", () => {
		const codes = Arr.map(Rec.values(Policy.permissions), (spec) => spec.code)
		expect(Arr.dedupe(codes)).toHaveLength(codes.length)
	})

	it("round-trips a custom role's permissions through their codes", () => {
		const list: Policy.Grants = ["telemetry:read", "alerts:manage", "oncall:manage"]
		expect(Policy.decodeCustomPermissions(Policy.encodePermissions(list))).toEqual(
			Policy.decodeCustomPermissions(Policy.encodePermissions(Arr.reverse(list))),
		)
		expect(new Set(Policy.decodeCustomPermissions(Policy.encodePermissions(list)))).toEqual(new Set(list))
	})

	it("keeps every way to reach Admin's power out of custom roles", () => {
		for (const permission of [
			"members:manage",
			"roles:manage",
			"organization:manage",
			"api_keys:manage",
			"sso:manage",
			"warehouse:manage",
			"code_review:auto_approve",
		] as const) {
			expect(Policy.grantableToCustomRoles(permission)).toBe(false)
		}
		expect(Policy.grantableToCustomRoles("billing:manage")).toBe(true)
	})

	it("drops codes it does not know and permissions a custom role may not hold", () => {
		const stored = [
			...Policy.encodePermissions(["members:manage", "roles:manage", "billing:manage"]),
			9999,
		]
		expect(Policy.decodeCustomPermissions(stored)).toEqual(["billing:manage"])
	})

	it("adds what stored permissions imply, so a role stored before an implication gains it", () => {
		expect(Policy.decodeCustomPermissions(Policy.encodePermissions(["query:sql"]))).toEqual([
			"telemetry:read",
			"query:sql",
		])
	})
})

describe("custom role metadata", () => {
	const roleId = "role_abcdefabcdef"

	it("reads an org:custom member's permissions from the membership metadata", () => {
		const metadata = {
			[Policy.MEMBERSHIP_ROLE_METADATA_KEY]: {
				id: roleId,
				permissions: Policy.encodePermissions(["alerts:manage"]),
			},
		}
		expect(Policy.customPermissionsFromMembershipMetadata(metadata)).toEqual([
			"telemetry:read",
			"alerts:manage",
		])
	})

	it("grants nothing for missing or malformed membership metadata", () => {
		expect(Policy.customPermissionsFromMembershipMetadata(undefined)).toEqual([])
		expect(Policy.customPermissionsFromMembershipMetadata({ maple_role: { id: "nope" } })).toEqual([])
		expect(Option.isNone(Policy.membershipRoleFromMetadata({ maple_role: "x" }))).toBe(true)
	})

	it("reads the organization's role definitions, and none from unreadable metadata", () => {
		const stored = {
			[Policy.ORG_ROLES_METADATA_KEY]: {
				roles: [
					{
						id: roleId,
						name: "On-call",
						description: "",
						permissions: [10],
						createdAt: 1,
						updatedAt: 2,
					},
				],
			},
			region: "eu",
		}
		expect(Arr.map(Policy.customRolesFromOrgMetadata(stored), (role) => role.name)).toEqual(["On-call"])
		expect(Policy.customRolesFromOrgMetadata({ maple_roles: { roles: [{ id: 1 }] } })).toEqual([])
	})

	it("starts an organization without definitions at version 0, and refuses to read garbled ones", () => {
		expect(Policy.versionedCustomRolesFromOrgMetadata({ region: "eu" })).toEqual(
			Option.some({ version: 0, roles: [] }),
		)
		// A writer that read this as no roles would replace every role the organization has.
		expect(
			Option.isNone(
				Policy.versionedCustomRolesFromOrgMetadata({ maple_roles: { roles: [{ id: 1 }] } }),
			),
		).toBe(true)
	})
})
