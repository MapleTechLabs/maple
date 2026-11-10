/**
 * Brings stored secrets onto the current key and envelope.
 *
 * A value needs resealing when its ciphertext does not start with the primary key's v2 prefix:
 * it is in the pre-v2 envelope, or it was sealed by a key that has since been rotated out of
 * the primary slot. One pass serves both the v2 migration and every later rotation
 * (docs/secret-encryption.md).
 */
import { Array as Arr, Context, Effect, Layer, Option, Record as Rec } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { currentEnvelopePrefix, secretKeyringFromEnv } from "@maple/backend/platform/SecretBox"
import { RESEAL_TARGETS, SecretResealError, type PendingSecret, type ResealTarget } from "./reseal-targets"

interface SecretResealSweep {
	/** Values rewritten under the current key and envelope. */
	readonly resealed: number
	/** Values that would not open; they stay as they are and are retried next pass. */
	readonly failed: number
	/** Values still not on the current key and envelope after the pass. */
	readonly remaining: number
}

const PAGE_SIZE = 200
/** Bounds one pass per column; the rest waits for the next one. */
const MAX_PAGES_PER_TARGET = 10

const emptySweep: SecretResealSweep = { resealed: 0, failed: 0, remaining: 0 }

const addSweeps = (a: SecretResealSweep, b: SecretResealSweep): SecretResealSweep => ({
	resealed: a.resealed + b.resealed,
	failed: a.failed + b.failed,
	remaining: a.remaining + b.remaining,
})

const toPersistenceError = makePersistenceErrorMapper(SecretResealError, "Secret reseal database error")

export class SecretResealService extends Context.Service<SecretResealService>()(
	"@maple/backend/services/SecretResealService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const dbExecute = makeDbExecute(database, "SecretResealService", toPersistenceError)
			const keyring = yield* secretKeyringFromEnv(env, (message) => new SecretResealError({ message }))
			const prefix = currentEnvelopePrefix(keyring)

			const resealRow = (target: ResealTarget, row: PendingSecret) =>
				row.reseal(keyring).pipe(
					Effect.flatMap((sealed) => dbExecute((db) => row.write(db, sealed))),
					Effect.map((written): SecretResealSweep => ({
						...emptySweep,
						resealed: written ? 1 : 0,
					})),
					Effect.catch((error) =>
						Effect.logWarning("Stored secret could not be resealed").pipe(
							Effect.annotateLogs({
								"maple.secrets.slot": target.slotName,
								"maple.secrets.row": Arr.join(row.keys, "/"),
								"maple.secrets.reason": error.message,
							}),
							Effect.as<SecretResealSweep>({ ...emptySweep, failed: 1 }),
						),
					),
				)

			const resealPages = (
				target: ResealTarget,
				cursor: ReadonlyArray<string> | null,
				pagesLeft: number,
				done: SecretResealSweep,
			): Effect.Effect<SecretResealSweep, SecretResealError> =>
				Effect.gen(function* () {
					const rows = yield* dbExecute((db) => target.pending(db, prefix, cursor, PAGE_SIZE))
					const outcomes = yield* Effect.forEach(rows, (row) => resealRow(target, row))
					const total = Arr.reduce(outcomes, done, addSweeps)
					const last = Arr.last(rows)
					return rows.length < PAGE_SIZE || pagesLeft <= 1 || Option.isNone(last)
						? total
						: yield* resealPages(target, last.value.keys, pagesLeft - 1, total)
				})

			/** One column. A database failure here is logged and leaves the other columns their pass. */
			const resealTarget = Effect.fn("SecretResealService.resealTarget")(function* (
				target: ResealTarget,
			) {
				yield* Effect.annotateCurrentSpan("maple.secrets.slot", target.slotName)
				const done = yield* resealPages(target, null, MAX_PAGES_PER_TARGET, emptySweep)
				// Counted every pass: "nothing remaining" is what a key removal waits for.
				const remaining = yield* dbExecute((db) => target.countPending(db, prefix))
				const sweep = { ...done, remaining }
				yield* Effect.annotateCurrentSpan({
					"maple.secrets.resealed": sweep.resealed,
					"maple.secrets.failed": sweep.failed,
					"maple.secrets.remaining": sweep.remaining,
				})
				return sweep
			})

			/** One pass over every sealed column. Safe to run concurrently with writers. */
			const resealDue: Effect.Effect<SecretResealSweep, SecretResealError> = Effect.forEach(
				Rec.values(RESEAL_TARGETS),
				(target) => Effect.result(resealTarget(target)),
			).pipe(
				Effect.flatMap((results) => {
					const sweep = Arr.reduce(Arr.getSuccesses(results), emptySweep, addSweeps)
					const failure = Arr.head(Arr.getFailures(results))
					// A column that could not be read has an unknown remaining count: report that, not zero.
					return Option.match(failure, {
						onNone: () => Effect.succeed(sweep),
						onSome: (error) => Effect.fail(error),
					})
				}),
				Effect.withSpan("SecretResealService.resealDue"),
			)

			return { resealDue }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
