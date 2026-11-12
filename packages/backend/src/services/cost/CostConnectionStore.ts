/**
 * Where a pasted cost credential lives: sealed in `cost_connections`, one per org and provider.
 * Saving one makes the org's cost source for that provider, replacing it keeps the source and its
 * history, removing it removes the source. Each provider checks its credential with its vendor
 * first, then stores it here, and its adapter reads it back for a pull.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { CostConnections, CostSources } from "@maple/db/tables"
import type { OrgId, UserId } from "@maple/primitives"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { openSecret, sealSecret, secretKeyringFromEnv } from "@maple/backend/platform/SecretBox"
import { costConnectionSecretSlot } from "@maple/backend/platform/secret-slots"
import type { CostPullSource } from "./CostProvider"
import { type CostConnectionProvider, reconcileCostConnectionSources } from "./cost-connection-sources"

/** `secret`: the deployment's key could not seal or open the value. `database`: Postgres failed. */
export class CostConnectionStoreError extends Schema.TaggedError<CostConnectionStoreError>()(
	"@maple/backend/cost/CostConnectionStoreError",
	{
		message: Schema.String,
		reason: Schema.Literals(["database", "secret"]),
	},
) {}

const secretFailed = (message: string) => new CostConnectionStoreError({ message, reason: "secret" })

export interface CostConnectionInput {
	readonly orgId: OrgId
	readonly userId: UserId
	readonly provider: CostConnectionProvider
	readonly secret: Redacted.Redacted
	/** The vendor's account the credential reads, as the vendor answered when it was checked. */
	readonly accountId: string
	readonly accountLabel: string
}

export interface CostConnectionCredential {
	readonly secret: Redacted.Redacted
	readonly accountId: string
	readonly accountLabel: string
}

export interface CostConnectionStoreApi {
	/**
	 * Seals and saves the credential, and makes the provider's cost source. `other_account`: the
	 * org's source reads another account, whose days this one's spend would overwrite, so nothing
	 * is written.
	 */
	readonly save: (
		input: CostConnectionInput,
	) => Effect.Effect<"saved" | "other_account", CostConnectionStoreError>
	/** Deletes the credential and its cost source. */
	readonly remove: (
		orgId: OrgId,
		provider: CostConnectionProvider,
	) => Effect.Effect<void, CostConnectionStoreError>
	/** The credential a source's pull reads with; none when the connection is gone or another org's. */
	readonly load: (
		provider: CostConnectionProvider,
		source: CostPullSource,
	) => Effect.Effect<Option.Option<CostConnectionCredential>, CostConnectionStoreError>
}

export class CostConnectionStore extends Context.Service<CostConnectionStore, CostConnectionStoreApi>()(
	"@maple/backend/services/cost/CostConnectionStore",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			// Read at first use, not here: an unusable key must not stop the sync of other providers.
			const keyring = yield* Effect.cached(secretKeyringFromEnv(env, secretFailed))
			const dbExecute = makeDbExecute(
				database,
				"CostConnectionStore",
				(error) => new CostConnectionStoreError({ message: error.message, reason: "database" }),
			)

			const save = Effect.fn("CostConnectionStore.save")(function* (input: CostConnectionInput) {
				const { orgId, provider, accountId } = input
				yield* Effect.annotateCurrentSpan({ orgId, "maple.cost.provider": provider })
				const secrets = yield* keyring
				// Bound to the org and the provider: a row copied onto another of either no longer opens.
				const sealed = yield* sealSecret(
					secrets,
					costConnectionSecretSlot,
					{ orgId, provider },
					Redacted.value(input.secret),
					secretFailed,
				)
				const now = yield* Clock.currentTimeMillis
				const next = {
					secretCiphertext: sealed.ciphertext,
					secretIv: sealed.iv,
					secretTag: sealed.tag,
					accountLabel: input.accountLabel,
					updatedAt: now,
					updatedBy: input.userId,
				}
				const saved = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							// A replaced credential keeps the row's id, which the cost source points at.
							// Another account's credential matches no row.
							const [row] = yield* db.run(
								PG.insertInto(CostConnections)
									.values({
										id: randomUUID(),
										orgId,
										provider,
										accountId,
										createdAt: now,
										...next,
									})
									.onConflictDoUpdate({
										target: ["orgId", "provider"],
										set: next,
										where: ($) => $.accountId.eq(accountId),
									})
									.returning(($) => ({ id: $.id })),
							)
							if (row === undefined) return false
							// The source shows on the Cost page at once, not at the next sync tick.
							yield* reconcileCostConnectionSources(db, now, provider, orgId)
							// A source held for its old credential's failure is due again with the new one. A
							// pull still in flight on the old one loses its claim, so its failure writes no hold.
							yield* db.run(
								PG.update(CostSources)
									.set({
										leaseUntil: null,
										lastError: null,
										lastErrorReason: null,
										nextAttemptAt: null,
										consecutiveFailures: 0,
										updatedAt: now,
									})
									.where(($) => [
										$.orgId.eq(orgId),
										$.provider.eq(provider),
										$.connectionRef.eq(row.id),
									]),
							)
							return true
						}),
					),
				)
				return saved ? "saved" : "other_account"
			})

			const remove = Effect.fn("CostConnectionStore.remove")(function* (
				orgId: OrgId,
				provider: CostConnectionProvider,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.cost.provider": provider })
				const now = yield* Clock.currentTimeMillis
				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* db.run(
								PG.deleteFrom(CostConnections).where(($) => [
									$.orgId.eq(orgId),
									$.provider.eq(provider),
								]),
							)
							yield* reconcileCostConnectionSources(db, now, provider, orgId)
						}),
					),
				)
			})

			const load = Effect.fn("CostConnectionStore.load")(function* (
				provider: CostConnectionProvider,
				source: CostPullSource,
			) {
				// By org and provider as well as id: a source never reads another org's credential.
				const [row] = yield* dbExecute((db) =>
					db.run(
						PG.from(CostConnections)
							.select()
							.where(($) => [
								$.orgId.eq(source.orgId),
								$.provider.eq(provider),
								$.id.eq(source.connectionRef),
							])
							.limit(1),
					),
				)
				if (row === undefined) return Option.none<CostConnectionCredential>()
				const secrets = yield* keyring
				const secret = yield* openSecret(
					secrets,
					costConnectionSecretSlot,
					{ orgId: row.orgId, provider: row.provider },
					{ ciphertext: row.secretCiphertext, iv: row.secretIv, tag: row.secretTag },
					secretFailed,
				)
				return Option.some<CostConnectionCredential>({
					secret: Redacted.make(secret),
					accountId: row.accountId,
					accountLabel: row.accountLabel,
				})
			})

			return { save, remove, load } satisfies CostConnectionStoreApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
