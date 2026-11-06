import * as Policy from "@maple/domain/policy"
import { Array as Arr, Option, String as Str } from "effect"

/** A role the Members page can give, by its Clerk key. */
export type OrgRole = Policy.ClerkRoleKey

/** The assignable Clerk role keys, lowest role first. */
export const orgRoleKeys: ReadonlyArray<OrgRole> = Arr.map(Policy.assignableRoles, (entry) => entry.clerkKey)

const [memberEntry] = Policy.assignableRoles

/** A Clerk role string's entry, read through `Policy.roleOf` (unknown roles are members). */
const entryOf = (role: string): Policy.AssignableRole => {
	const policyRole = Policy.roleOf(role)
	return Option.getOrElse(
		Arr.findFirst(Policy.assignableRoles, (entry) => entry.role === policyRole),
		(): Policy.AssignableRole => memberEntry,
	)
}

export function toOrgRole(role: string): OrgRole {
	return entryOf(role).clerkKey
}

export function orgRoleLabel(role: string): string {
	return entryOf(role).label
}

/** "an admin", "a member": the role as a noun after "is now" or "Make Ada". */
export function orgRoleNoun(role: string): string {
	const noun = Str.toLowerCase(entryOf(role).label)
	return `${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun}`
}

/**
 * Whether the signed-in user may leave the organization. The last admin cannot: the org would be
 * left with nobody able to manage it. `adminCount` is undefined while the membership list loads.
 */
export type LeaveEligibility = "allowed" | "checking" | "last-admin"

export function leaveEligibility(input: {
	readonly isAdmin: boolean
	readonly adminCount: number | undefined
}): LeaveEligibility {
	if (!input.isAdmin) return "allowed"
	if (input.adminCount === undefined) return "checking"
	return input.adminCount > 1 ? "allowed" : "last-admin"
}

/** The confirm-strip question before a role change, naming what the new role can do. */
export function roleChangePrompt(name: string, next: OrgRole): { question: string; confirmLabel: string } {
	const entry = entryOf(next)
	return {
		question: `Make ${name} ${orgRoleNoun(next)}? ${entry.summary}`,
		confirmLabel: `Make ${Str.toLowerCase(entry.label)}`,
	}
}
