import { Array as Arr, Option, Order, Schema } from "effect"

/**
 * The org roles, lowest first. Each one holds every permission of the roles below it, so a
 * permission names only its lowest role. `root` is Maple's own operator access and self-hosted
 * mode; it is never assigned in Clerk.
 */
export const Role = Schema.Literals(["analyst", "member", "engineer", "admin", "root"])
export type Role = typeof Role.Type

const RANK = {
	analyst: 0,
	member: 1,
	engineer: 2,
	admin: 3,
	root: 4,
} as const satisfies Record<Role, number>

const byRank: Order.Order<Role> = Order.mapInput(Order.Number, (role) => RANK[role])

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

/** Read-only, for people who follow the product without operating it. Not offered on the Members page yet. */
const analystRole = {
	role: "analyst",
	clerkKey: "org:analyst",
	label: "Analyst",
	summary: "Follows incidents, reliability, product analytics and cost. Changes nothing.",
} as const satisfies { role: Role; clerkKey: string; label: string; summary: string }

const clerkRoles = [analystRole, ...assignableRoles] as const

/**
 * A Clerk or session role string as a {@link Role}. A role this code does not know reads as
 * analyst, the least it can hold.
 */
export const roleOf = (name: string): Role => {
	if (name === "root") return "root"
	return Option.getOrElse(
		Option.map(
			Arr.findFirst(clerkRoles, (entry) => entry.clerkKey === name),
			(entry): Role => entry.role,
		),
		(): Role => "analyst",
	)
}

/**
 * The highest role among a session's role strings. No roles at all reads as member: a person's
 * Clerk membership always carries one, so only Maple's own agents arrive without.
 */
export const highestRole = (roles: ReadonlyArray<string>): Role =>
	Arr.match(Arr.map(roles, roleOf), {
		onEmpty: (): Role => "member",
		onNonEmpty: Arr.max(byRank),
	})

export const isAtLeast = (role: Role, min: Role): boolean => RANK[role] >= RANK[min]

/** Whether `role` holds more than `other`: a credential pinned to it outlives a demotion to `other`. */
export const outranks = (role: Role, other: Role): boolean => RANK[role] > RANK[other]

/** "org admins and engineers": who holds a permission whose lowest role is `min`, for messages. */
export const holdersPhrase = (min: Role): string => {
	switch (min) {
		case "analyst":
			return "people in the organization"
		case "member":
			return "org admins, engineers and members"
		case "engineer":
			return "org admins and engineers"
		case "admin":
			return "org admins"
		case "root":
			return "Maple operators"
	}
}
