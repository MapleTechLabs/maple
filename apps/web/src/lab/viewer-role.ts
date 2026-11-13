import * as Policy from "@maple/domain/policy"
import { Effect, Option, Schema } from "effect"

// `?role=admin|member|analyst` for a lab that renders a page as the viewer would see it. Without
// the flag a lab keeps the full rights it always had.

const ROLES = ["admin", "member", "analyst"] as const

export const LabRole = Schema.Literals(ROLES)
export type LabRole = typeof LabRole.Type

const decodeRole = Schema.decodeUnknownOption(LabRole)

/** The URL's `?role=`; every permission (`admin`) when it names none. */
export const readLabRole: Effect.Effect<LabRole> = Effect.sync(() =>
	Option.getOrElse(
		decodeRole(new URLSearchParams(globalThis.location.search).get("role")),
		(): LabRole => "admin",
	),
)

/** The session's grants for the role, as the page's own read would answer. */
export const labGrants = (role: LabRole): ReadonlyArray<Policy.Permission> =>
	role === "admin" ? Policy.allPermissions : Policy.grantsOf([`org:${role}`])
