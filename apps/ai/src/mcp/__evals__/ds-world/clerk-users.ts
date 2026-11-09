import { Array as Arr, String as Str } from "effect"
import type { FakeClerkUser } from "@maple/data-sources/clerk/testing"

const DAY_MS = 86_400_000

/** Signups on the day `d` days back (0 = the last 24 hours): growing, with a weekend dip. */
export const prodSignupsOnDay = (d: number): number => 4 + Math.floor((400 - d) / 50) - (d % 7 >= 5 ? 2 : 0)

/** Signups within the last `days` days, the number a correct "this week" answer contains for 7. */
export const prodSignupsWithin = (days: number): number =>
	Arr.reduce(Arr.makeBy(days, prodSignupsOnDay), 0, (sum, n) => sum + n)

const user = (id: string, email: string, createdAt: number, i: number, now: number): FakeClerkUser => {
	const signIn = i % 6 === 5 ? null : createdAt + ((i * 7919) % 3_600_000)
	return {
		id,
		createdAt,
		updatedAt: createdAt,
		lastSignInAt: signIn,
		// Only the latest activity, like Clerk: no per-day history to count DAU from.
		lastActiveAt:
			signIn === null ? null : Math.min(now - 60_000, signIn + ((i * 104_729) % (20 * DAY_MS))),
		email,
		username: null,
		firstName: `First${i}`,
		lastName: `Last${i}`,
		externalId: null,
		banned: i % 97 === 96,
		organizationIds: [],
	}
}

/** 400 days of production signups, newest last; deterministic relative to `now`. */
export const clerkProdUsers = (now: number): ReadonlyArray<FakeClerkUser> =>
	Arr.flatMap(
		Arr.makeBy(400, (d) => 399 - d),
		(d) => {
			const n = prodSignupsOnDay(d)
			return Arr.makeBy(n, (k) => {
				const i = d * 100 + k
				const createdAt = Math.floor(now - d * DAY_MS - ((k + 0.5) * DAY_MS) / n)
				return user(
					`user_p${Str.padStart(6, "0")(String(i))}`,
					`customer${i}@example.com`,
					createdAt,
					i,
					now,
				)
			})
		},
	)

export const CLERK_DEV_USER_COUNT = 60

/** Test accounts on the development instance: two a day for 30 days. */
export const clerkDevUsers = (now: number): ReadonlyArray<FakeClerkUser> =>
	Arr.makeBy(CLERK_DEV_USER_COUNT, (i) =>
		user(`user_d${i}`, `qa+${i}@acme.dev`, Math.floor(now - (i + 0.5) * (DAY_MS / 2)), i, now),
	)
