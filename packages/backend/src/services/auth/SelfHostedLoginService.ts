import { createHash } from "node:crypto"
import {
	SelfHostedAuthDisabledError,
	SelfHostedInvalidPasswordError,
	SelfHostedLoginResponse,
	SelfHostedLoginThrottledError,
	SelfHostedLoginUnavailableError,
} from "@maple/domain/http"
import { makeLoginSelfHosted } from "@maple/auth"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import { SelfHostedLoginAttempts } from "@maple/db/tables"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"

/** Failures per client before it is locked out, and across all clients before the root account is. */
export const CLIENT_MAX_FAILURES = 5
export const GLOBAL_MAX_FAILURES = 50
/** First lockout; each further failure past the limit doubles it, up to the cap. */
export const BASE_LOCKOUT_MS = 5 * 60 * 1000
export const MAX_LOCKOUT_MS = 60 * 60 * 1000
/** A key with no failure for this long starts over from zero. */
export const FAILURE_RESET_MS = 2 * 60 * 60 * 1000

const GLOBAL_KEY = "root"
const clientKey = (client: string) => `client:${createHash("sha256").update(client).digest("hex")}`

const unavailable = makePersistenceErrorMapper(
	SelfHostedLoginUnavailableError,
	"Self-hosted login throttle unavailable",
)

const throttled = (remainingMs: number) => {
	const retryAfterSeconds = Math.ceil(remainingMs / 1000)
	return new SelfHostedLoginThrottledError({
		message: `Too many failed sign-in attempts. Try again in ${retryAfterSeconds} seconds.`,
		retryAfterSeconds,
	})
}

const lockoutFor = (failures: number, max: number): number | null =>
	failures < max ? null : Math.min(BASE_LOCKOUT_MS * 2 ** (failures - max), MAX_LOCKOUT_MS)

export class SelfHostedLoginService extends Context.Service<
	SelfHostedLoginService,
	{
		/** Root-password login, refused while the client or the root account is locked out. */
		readonly login: (
			password: string,
			client: string,
		) => Effect.Effect<
			SelfHostedLoginResponse,
			| SelfHostedAuthDisabledError
			| SelfHostedInvalidPasswordError
			| SelfHostedLoginThrottledError
			| SelfHostedLoginUnavailableError
		>
	}
>()("@maple/api/services/SelfHostedLoginService", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const loginSelfHosted = makeLoginSelfHosted(env)
		const database = yield* Database
		const dbExecute = makeDbExecute(database, "SelfHostedLoginService", unavailable)

		type Entry = { readonly key: string; readonly max: number }

		// Counts the attempt as a failure before the password is checked, so a parallel burst
		// cannot slip past the limit. Refused only when a lockout was already in force.
		const reserve = (db: MapleDb, entry: Entry, now: number) =>
			Effect.gen(function* () {
				yield* db.run(
					PG.insertInto(SelfHostedLoginAttempts)
						.values({
							key: entry.key,
							failures: 0,
							windowStartedAt: now,
							lockedUntil: null,
							updatedAt: now,
						})
						.onConflictDoNothing(),
				)
				const [row] = yield* db.run(
					PG.from(SelfHostedLoginAttempts)
						.select()
						.where(($) => [$.key.eq(entry.key)])
						.forUpdate(),
				)
				if (row !== undefined && row.lockedUntil !== null && row.lockedUntil > now) {
					return yield* throttled(row.lockedUntil - now)
				}
				const stale = row === undefined || now - row.updatedAt > FAILURE_RESET_MS
				const failures = stale ? 1 : row.failures + 1
				const lockout = lockoutFor(failures, entry.max)
				yield* db.run(
					PG.update(SelfHostedLoginAttempts)
						.set({
							failures,
							windowStartedAt: stale ? now : row.windowStartedAt,
							lockedUntil: lockout === null ? null : now + lockout,
							updatedAt: now,
						})
						.where(($) => [$.key.eq(entry.key)]),
				)
			})

		// A refusal fails the transaction, so neither key counts an attempt that never reached the password.
		const reserveAttempt = Effect.fn("SelfHostedLoginService.reserveAttempt")(function* (
			entries: ReadonlyArray<Entry>,
			now: number,
		) {
			yield* dbExecute((db) =>
				db.transaction(
					Effect.forEach(entries, (entry) => reserve(db, entry, now), { discard: true }),
				),
			)
		})

		// A correct password takes back its reserved failure: the client starts over, the global count drops by one.
		const release = Effect.fn("SelfHostedLoginService.release")(function* (
			perClient: Entry,
			global: Entry,
		) {
			yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* db.run(
							PG.deleteFrom(SelfHostedLoginAttempts).where(($) => [$.key.eq(perClient.key)]),
						)
						const [row] = yield* db.run(
							PG.from(SelfHostedLoginAttempts)
								.select()
								.where(($) => [$.key.eq(global.key)])
								.forUpdate(),
						)
						if (row === undefined) return
						const failures = Math.max(0, row.failures - 1)
						yield* db.run(
							PG.update(SelfHostedLoginAttempts)
								.set({
									failures,
									lockedUntil:
										lockoutFor(failures, global.max) === null ? null : row.lockedUntil,
								})
								.where(($) => [$.key.eq(global.key)]),
						)
					}),
				),
			)
		})

		const login = Effect.fn("SelfHostedLoginService.login")(function* (password: string, client: string) {
			// Clerk mode never reaches the throttle table; the primitive refuses it outright.
			if (env.MAPLE_AUTH_MODE.toLowerCase() === "clerk") return yield* loginSelfHosted(password)
			const perClient = { key: clientKey(client), max: CLIENT_MAX_FAILURES }
			const global = { key: GLOBAL_KEY, max: GLOBAL_MAX_FAILURES }
			yield* reserveAttempt([perClient, global], yield* Clock.currentTimeMillis)
			const response = yield* loginSelfHosted(password)
			yield* release(perClient, global)
			return response
		})

		return { login }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}

/** The throttle key for a login: the socket peer where the runtime has one, else the edge-supplied address. */
export const resolveLoginClient = (
	remoteAddress: Option.Option<string>,
	headers: Readonly<Record<string, string | undefined>>,
): string => Option.getOrElse(remoteAddress, () => headers["cf-connecting-ip"] ?? "unknown")
