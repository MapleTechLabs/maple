// The Morph API key an org's Morph spend is read with: checked with Morph, then kept in the shared
// cost connection store. Only an organization key owned by an organization admin reads spend.
import * as PG from "@maple-dev/effect-orm/postgres"
import { MorphSpendReadings } from "@maple/db/tables"
import {
	CostConnectionPersistenceError,
	CostConnectionValidationError,
	MORPH_COST_KEY_MAX_LENGTH,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import { Clock, Context, Duration, Effect, Layer, Redacted, Array as Arr, String as Str } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { CostConnectionStore, type CostConnectionStoreError } from "./CostConnectionStore"
import * as MorphBudgets from "./providers/morph/morph-budgets-api"
import { toMemberReadings, writeReadings } from "./providers/morph/MorphCostProvider"

const VALIDATE_TIMEOUT = Duration.seconds(20)
/**
 * Morph names no organization, so every Morph key of an org reads one account. A replacement
 * from another Morph organization is caught by its members instead (see `set`).
 */
const ACCOUNT_ID = "organization"
const ACCOUNT_LABEL = "Organization"

const refused = (message: string) => new CostConnectionValidationError({ message })

const toKeyError = (
	error: MorphBudgets.MorphBudgetsError,
): CostConnectionValidationError | CostConnectionPersistenceError => {
	if (error.kind === "unauthorized") {
		return refused("Morph rejected this key. Create one at morphllm.com/dashboard/api-keys.")
	}
	if (error.kind === "forbidden") {
		return refused(
			"This key cannot read the organization's spend. Use a key of a Morph organization, owned by one of its admins. Keys of personal accounts cannot read spend.",
		)
	}
	return new CostConnectionPersistenceError({ message: "Could not check this key with Morph. Try again." })
}

const toPersistenceError = (error: CostConnectionStoreError) =>
	new CostConnectionPersistenceError({ message: error.message })

/** A Morph key: `sk-` and printable text, unbroken. Nothing else is ever sent as one. */
const couldBeKey = (key: string): boolean =>
	key.length <= MORPH_COST_KEY_MAX_LENGTH && /^sk-[\x21-\x7e]+$/.test(key)

export interface MorphCostConnectionServiceApi {
	/** Saves the key and answers the Morph account it reads. */
	readonly set: (
		orgId: OrgId,
		userId: UserId,
		apiKey: string,
	) => Effect.Effect<
		{ readonly accountId: string; readonly accountLabel: string },
		CostConnectionPersistenceError | CostConnectionValidationError
	>
	readonly remove: (orgId: OrgId) => Effect.Effect<void, CostConnectionPersistenceError>
}

export class MorphCostConnectionService extends Context.Service<
	MorphCostConnectionService,
	MorphCostConnectionServiceApi
>()("@maple/backend/services/cost/MorphCostConnectionService", {
	make: Effect.gen(function* () {
		const connections = yield* CostConnectionStore
		const httpClient = yield* HttpClient.HttpClient
		const database = yield* Database
		const dbExecute = makeDbExecute(
			database,
			"MorphCostConnectionService",
			(error) => new CostConnectionPersistenceError({ message: error.message }),
		)

		/**
		 * The members of the newest reading the org's saved key took: one reading writes every member
		 * at the same instant. Readings go with their connection, so these are its.
		 */
		const knownMembers = Effect.fnUntraced(function* (orgId: OrgId) {
			// One statement, so the newest reading's time and all its members come from one snapshot.
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(MorphSpendReadings)
						.select(($) => ({ memberId: $.memberId }))
						.where(($) => [
							$.orgId.eq(orgId),
							PG.sql
								.cond`${$.lastReadAt} = (select max(last_read_at) from morph_spend_readings where org_id = ${orgId})`,
						]),
				),
			)
			return Arr.dedupe(Arr.map(rows, (row) => row.memberId))
		})

		const set = Effect.fn("MorphCostConnectionService.set")(function* (
			orgId: OrgId,
			userId: UserId,
			rawKey: string,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const apiKey = Str.trim(rawKey)
			if (!couldBeKey(apiKey)) {
				return yield* refused("That is not a Morph API key. They start with sk-.")
			}
			const secret = Redacted.make(apiKey)
			const readAt = yield* Clock.currentTimeMillis
			const list = yield* MorphBudgets.listMemberSpend(httpClient, secret).pipe(
				Effect.mapError(toKeyError),
				Effect.timeoutOrElse({
					duration: VALIDATE_TIMEOUT,
					orElse: () =>
						Effect.fail(
							new CostConnectionPersistenceError({
								message: "Could not reach Morph to check this key. Try again.",
							}),
						),
				}),
			)
			yield* Effect.annotateCurrentSpan("maple.cost.morph.members", list.members.length)
			// Best effort: members are the only trace of which Morph organization a key reads. A
			// replacement missing most of the source's members is taken for another organization's,
			// whose spend would show as jumps in this one's.
			const known = yield* knownMembers(orgId)
			const fresh = new Set(Arr.map(list.members, (member) => member.userId))
			const kept = Arr.filter(known, (member) => fresh.has(member)).length
			if (Arr.isReadonlyArrayNonEmpty(known) && kept * 2 < known.length) {
				return yield* refused(
					"This key belongs to another Morph organization than the source does. Remove the source first to switch organizations.",
				)
			}
			const readings = yield* Effect.fromOption(toMemberReadings(list)).pipe(
				Effect.mapError(() => refused("Morph reported a spend Maple cannot read.")),
			)
			const account = { accountId: ACCOUNT_ID, accountLabel: ACCOUNT_LABEL }
			// The check's reading is kept with the row the save wrote, in its transaction: Morph never
			// serves it again once its month has ended. The account id is the same for every Morph key,
			// so `other_account` cannot come back.
			yield* connections
				.save({
					orgId,
					userId,
					provider: "morph",
					secret,
					...account,
					afterSave: (db, connectionId) =>
						Effect.asVoid(
							writeReadings(
								db,
								{ orgId, connectionRef: connectionId },
								list.month,
								readings,
								readAt,
							),
						),
				})
				.pipe(Effect.mapError(toPersistenceError))
			return account
		})

		const remove = Effect.fn("MorphCostConnectionService.remove")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			yield* connections.remove(orgId, "morph").pipe(Effect.mapError(toPersistenceError))
		})

		return { set, remove } satisfies MorphCostConnectionServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(FetchHttpClient.layer, CostConnectionStore.layer)),
	)
}
