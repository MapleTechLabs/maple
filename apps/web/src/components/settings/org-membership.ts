export type OrgRole = "org:admin" | "org:member"

/** Clerk role strings outside the two Maple roles read as member, the safer reading. */
export function toOrgRole(role: string): OrgRole {
	return role === "org:admin" ? "org:admin" : "org:member"
}

export function orgRoleLabel(role: string): string {
	return toOrgRole(role) === "org:admin" ? "Admin" : "Member"
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

/** The confirm-strip question before a role change, naming what the new role can or cannot do. */
export function roleChangePrompt(name: string, next: OrgRole): { question: string; confirmLabel: string } {
	return next === "org:admin"
		? {
				question: `Make ${name} an admin? Admins can manage billing and delete the organization.`,
				confirmLabel: "Make admin",
			}
		: {
				question: `Make ${name} a member? Members can no longer manage billing, keys or members.`,
				confirmLabel: "Make member",
			}
}
