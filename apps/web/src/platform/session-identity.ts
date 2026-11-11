import { Option, Schema } from "effect"
import type { ClerkSnapshot } from "./clerk"

// The session identity: the session and its product events carry the signed-in user, their org,
// and their role and plan there.

export const SessionIdentity = Schema.Struct({
	id: Schema.String,
	username: Schema.optionalKey(Schema.String),
	email: Schema.optionalKey(Schema.String),
	groupId: Schema.optionalKey(Schema.String),
	groupName: Schema.optionalKey(Schema.String),
	/** The membership role in the active org and its Autumn plan id, each once known. */
	traits: Schema.Struct({
		role: Schema.optionalKey(Schema.String),
		plan: Schema.optionalKey(Schema.String),
	}),
})
export type SessionIdentity = typeof SessionIdentity.Type

const defined = <K extends string>(key: K, value: string | null | undefined) =>
	value === null || value === undefined ? {} : { [key]: value }

/**
 * The identity a snapshot names, `null` when signed out (`identify(undefined)`). `plan` is the active
 * org's plan id, `null` until its customer read settles.
 */
export const identityOf = (snapshot: ClerkSnapshot, plan: string | null): SessionIdentity | null =>
	Option.match(snapshot.maybeUserId, {
		onNone: () => null,
		onSome: (id) => {
			const user = Option.getOrNull(snapshot.maybeUser)
			const organization = Option.getOrNull(snapshot.maybeOrganization)
			return {
				id,
				...defined("username", user?.fullName),
				...defined("email", user?.email),
				...defined("groupId", Option.getOrNull(snapshot.maybeOrgId)),
				...defined("groupName", organization?.name),
				traits: {
					...defined("role", Option.getOrNull(snapshot.maybeRole)),
					...defined("plan", plan),
				},
			}
		},
	})

/** The effect's deps: identify again only when one of the primitives changed. */
export const isSameIdentity = (a: SessionIdentity | null, b: SessionIdentity | null): boolean =>
	a === null || b === null
		? a === b
		: a.id === b.id &&
			a.username === b.username &&
			a.email === b.email &&
			a.groupId === b.groupId &&
			a.groupName === b.groupName &&
			a.traits.role === b.traits.role &&
			a.traits.plan === b.traits.plan
