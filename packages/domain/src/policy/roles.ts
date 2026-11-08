import { Array as Arr, Option, Schema } from "effect"

/**
 * The org roles, lowest first. Each one holds every permission of the roles below it, so a
 * permission names only its lowest role. `root` is Maple's own operator access and self-hosted
 * mode; it is never assigned in Clerk.
 */
export const Role = Schema.Literals(["member", "engineer", "admin", "root"])
export type Role = typeof Role.Type

const RANK = { member: 0, engineer: 1, admin: 2, root: 3 } as const satisfies Record<Role, number>

/** What the Members page shows for a role a person can be given in Clerk. */
export const assignableRoles = [
	{
		role: "member",
		clerkKey: "org:member",
		label: "Member",
		summary: "Reads all telemetry, posts incident updates and builds dashboards.",
	},
	{
		role: "engineer",
		clerkKey: "org:engineer",
		label: "Engineer",
		summary: "Also manages integrations, code review, alerts, monitors, status pages and ingest setup.",
	},
	{
		role: "admin",
		clerkKey: "org:admin",
		label: "Admin",
		summary: "Also manages billing, members, API keys and the organization itself.",
	},
] as const satisfies ReadonlyArray<{ role: Role; clerkKey: string; label: string; summary: string }>

export type AssignableRole = (typeof assignableRoles)[number]
export type ClerkRoleKey = AssignableRole["clerkKey"]

/** A Clerk or session role string as a {@link Role}. Anything unknown reads as member, the safe reading. */
export const roleOf = (name: string): Role => {
	if (name === "root") return "root"
	return Option.getOrElse(
		Option.map(
			Arr.findFirst(assignableRoles, (entry) => entry.clerkKey === name),
			(entry): Role => entry.role,
		),
		(): Role => "member",
	)
}

/** The highest role among a session's role strings; `member` for none. */
export const highestRole = (roles: ReadonlyArray<string>): Role =>
	Arr.reduce(roles, "member" as Role, (best, name) => {
		const role = roleOf(name)
		return RANK[role] > RANK[best] ? role : best
	})

export const isAtLeast = (role: Role, min: Role): boolean => RANK[role] >= RANK[min]

/** Whether `role` holds more than `other`: a credential pinned to it outlives a demotion to `other`. */
export const outranks = (role: Role, other: Role): boolean => RANK[role] > RANK[other]

/** "org admins and engineers": who holds a permission whose lowest role is `min`, for messages. */
export const holdersPhrase = (min: Role): string => {
	switch (min) {
		case "member":
			return "org members"
		case "engineer":
			return "org admins and engineers"
		case "admin":
			return "org admins"
		case "root":
			return "Maple operators"
	}
}
