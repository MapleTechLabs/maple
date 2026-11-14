import { Array as Arr, String as Str } from "effect"

/** A user as the fake Clerk stores it; the fake renders Clerk's wire shape from this. */
export interface FakeClerkUser {
	readonly id: string
	readonly createdAt: number
	readonly updatedAt: number
	readonly lastActiveAt: number | null
	readonly lastSignInAt: number | null
	readonly email: string
	/** Non-primary addresses; Clerk's email filters match these too. */
	readonly secondaryEmails?: ReadonlyArray<string>
	readonly username: string | null
	readonly firstName: string | null
	readonly lastName: string | null
	readonly externalId: string | null
	readonly banned: boolean
	readonly organizationIds: ReadonlyArray<string>
}

export interface FakeClerkOrganization {
	readonly id: string
	readonly name: string
	readonly slug: string
	readonly createdAt: number
	readonly updatedAt: number
}

const DOMAINS = ["example.com", "acme.dev", "gmail.com"] as const

/** Park-Miller LCG: the same seed gives the same users on every run. */
const random = (seed: number) => {
	let state = seed % 2_147_483_647
	return () => {
		state = (state * 48_271) % 2_147_483_647
		return state / 2_147_483_647
	}
}

/**
 * `count` users spread evenly over `[startMs, endMs)`, oldest first, each signed in a little
 * after signup and active some time later; every third user belongs to `org_1`.
 */
export const seedClerkUsers = (
	count: number,
	startMs: number,
	endMs: number,
	seed = 42,
): ReadonlyArray<FakeClerkUser> => {
	const next = random(seed)
	const step = (endMs - startMs) / Math.max(count, 1)
	return Arr.makeBy(count, (i) => {
		const createdAt = Math.floor(startMs + i * step)
		const signedIn = i % 5 === 4 ? null : createdAt + Math.floor(next() * 3_600_000)
		const domain = DOMAINS[i % DOMAINS.length] ?? "example.com"
		return {
			id: `user_${Str.padStart(5, "0")(String(i))}`,
			createdAt,
			updatedAt: createdAt,
			lastSignInAt: signedIn,
			lastActiveAt: signedIn === null ? null : signedIn + Math.floor(next() * 5 * 86_400_000),
			email: `person${i}@${domain}`,
			username: i % 2 === 0 ? `person${i}` : null,
			firstName: `First${i}`,
			lastName: `Last${i}`,
			externalId: i % 4 === 0 ? `ext_${i}` : null,
			banned: i % 10 === 9,
			organizationIds: i % 3 === 0 ? ["org_1"] : [],
		}
	})
}

export const seedClerkOrganizations = (
	count: number,
	startMs: number,
	endMs: number,
): ReadonlyArray<FakeClerkOrganization> => {
	const step = (endMs - startMs) / Math.max(count, 1)
	return Arr.makeBy(count, (i) => ({
		id: `org_${i + 1}`,
		name: `Team ${i + 1}`,
		slug: `team-${i + 1}`,
		createdAt: Math.floor(startMs + i * step),
		updatedAt: Math.floor(startMs + i * step),
	}))
}

export const userWire = (user: FakeClerkUser) => ({
	object: "user",
	id: user.id,
	created_at: user.createdAt,
	updated_at: user.updatedAt,
	last_active_at: user.lastActiveAt,
	last_sign_in_at: user.lastSignInAt,
	username: user.username,
	first_name: user.firstName,
	last_name: user.lastName,
	external_id: user.externalId,
	primary_email_address_id: `idn_${user.id}`,
	primary_phone_number_id: null,
	email_addresses: [
		{ id: `idn_${user.id}`, object: "email_address", email_address: user.email },
		...Arr.map(user.secondaryEmails ?? [], (email, i) => ({
			id: `idn_${user.id}_${i}`,
			object: "email_address",
			email_address: email,
		})),
	],
	phone_numbers: [],
	banned: user.banned,
	locked: false,
	two_factor_enabled: false,
	password_enabled: true,
})
