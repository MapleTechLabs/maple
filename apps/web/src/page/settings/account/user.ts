import { Effect, Schema } from "effect"
import type { ClerkUserResource } from "../../../platform/clerk"

// What the `/account` tabs read from Clerk's `useUser().user`, as plain data. Writes look the
// resource up again by id when they run (clerk-js resources are not data).

export const AccountEmail = Schema.Struct({
	id: Schema.String,
	email: Schema.String,
	isVerified: Schema.Boolean,
})
export type AccountEmail = typeof AccountEmail.Type

export const AccountPasskey = Schema.Struct({
	id: Schema.String,
	name: Schema.NullOr(Schema.String),
	createdAtMs: Schema.Number,
	lastUsedAtMs: Schema.NullOr(Schema.Number),
})
export type AccountPasskey = typeof AccountPasskey.Type

export const AccountExternal = Schema.Struct({
	id: Schema.String,
	provider: Schema.String,
	emailAddress: Schema.String,
	username: Schema.NullOr(Schema.String),
	isVerified: Schema.Boolean,
})
export type AccountExternal = typeof AccountExternal.Type

export const AccountUser = Schema.Struct({
	id: Schema.String,
	firstName: Schema.String,
	lastName: Schema.String,
	fullName: Schema.NullOr(Schema.String),
	hasImage: Schema.Boolean,
	primaryEmail: Schema.NullOr(Schema.String),
	primaryEmailAddressId: Schema.NullOr(Schema.String),
	emails: Schema.Array(AccountEmail),
	passkeys: Schema.Array(AccountPasskey),
	externalAccounts: Schema.Array(AccountExternal),
	passwordEnabled: Schema.Boolean,
	totpEnabled: Schema.Boolean,
	backupCodeEnabled: Schema.Boolean,
	deleteSelfEnabled: Schema.Boolean,
})
export type AccountUser = typeof AccountUser.Type

const isVerified = (verification: { readonly status: string | null } | null): boolean =>
	verification?.status === "verified"

export const toAccountUser = (user: ClerkUserResource): AccountUser => ({
	id: user.id,
	firstName: user.firstName ?? "",
	lastName: user.lastName ?? "",
	fullName: user.fullName,
	hasImage: user.hasImage,
	primaryEmail: user.primaryEmailAddress?.emailAddress ?? null,
	primaryEmailAddressId: user.primaryEmailAddressId,
	emails: user.emailAddresses.map((address) => ({
		id: address.id,
		email: address.emailAddress,
		isVerified: isVerified(address.verification),
	})),
	passkeys: user.passkeys.map((passkey) => ({
		id: passkey.id,
		name: passkey.name,
		createdAtMs: passkey.createdAt.getTime(),
		lastUsedAtMs: passkey.lastUsedAt === null ? null : passkey.lastUsedAt.getTime(),
	})),
	externalAccounts: user.externalAccounts.map((account) => ({
		id: account.id,
		provider: account.provider,
		emailAddress: account.emailAddress,
		username: account.username,
		isVerified: isVerified(account.verification),
	})),
	passwordEnabled: user.passwordEnabled,
	totpEnabled: user.totpEnabled,
	backupCodeEnabled: user.backupCodeEnabled,
	deleteSelfEnabled: user.deleteSelfEnabled,
})

/** The signed-in user as data, `null` signed out (the tabs then show their skeleton). */
export const readAccountUser: Effect.Effect<AccountUser | null> = Effect.sync(() => {
	const user = window.Clerk?.user
	return user === null || user === undefined ? null : toAccountUser(user)
})
