import * as Policy from "@maple/domain/policy"
import { Array as Arr, Option, String as Str } from "effect"

/** A built-in role the Members page can give, by its Clerk key. */
export type OrgRole = Policy.ClerkRoleKey

/** The built-in roles' Clerk keys, lowest role first. */
export const orgRoleKeys: ReadonlyArray<OrgRole> = Arr.map(Policy.builtInRoles, (entry) => entry.clerkKey)

const analystEntry = Policy.builtInRoles[0]
const memberEntry = Policy.builtInRoles[1]

/**
 * A Clerk role string's built-in entry. `root`, which Clerk never assigns, shows as a member; any
 * other role this build does not know reads as an analyst, as `Policy.grantsOf` reads it.
 */
const entryOf = (role: string): Policy.BuiltInRole =>
	role === "root"
		? memberEntry
		: Option.getOrElse(Policy.builtInRoleOf(role), (): Policy.BuiltInRole => analystEntry)

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
