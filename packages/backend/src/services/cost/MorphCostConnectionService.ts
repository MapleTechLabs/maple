// The Morph API key an org's Morph spend is read with: checked with Morph, then kept in the shared
// cost connection store. Any key reads usage: an organization key the organization's, a personal
// key its owner's.
import {
	CostConnectionPersistenceError,
	CostConnectionValidationError,
	MORPH_COST_KEY_MAX_LENGTH,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import {
	Clock,
	Context,
	Duration,
	Effect,
	Layer,
	Option,
	Redacted,
	Array as Arr,
	String as Str,
} from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { CostConnectionStore, type CostConnectionStoreError } from "./CostConnectionStore"
import * as MorphUsage from "./providers/morph/morph-usage-api"
import { addDays, utcToday } from "./sync-plan"

const VALIDATE_TIMEOUT = Duration.seconds(20)
/** Closed days two keys must agree on to count as one account. */
const FINGERPRINT_DAYS = 30
/** Morph names no account, only its kind: a key's account is told apart by its usage. */
const ACCOUNT_LABELS = { organization: "Organization", personal: "Personal account" } as const

const refused = (message: string) => new CostConnectionValidationError({ message })

const toKeyError = (
	error: MorphUsage.MorphUsageError,
): CostConnectionValidationError | CostConnectionPersistenceError =>
	error.kind === "unauthorized"
		? refused("Morph rejected this key. Create one at morphllm.com/dashboard/api-keys.")
		: new CostConnectionPersistenceError({ message: "Could not check this key with Morph. Try again." })

const unreachable = () =>
	Effect.fail(
		new CostConnectionPersistenceError({
			message: "Could not reach Morph to check this key. Try again.",
		}),
	)

/** Each closed day's spend, in micro-dollars: what two keys of one account answer alike. */
const fingerprint = (usage: MorphUsage.AccountUsage): string =>
	Arr.join(
		Arr.map(usage.days, (day) => `${day.date}=${Math.round(day.spend * 1_000_000)}`),
		",",
	)

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

		/**
		 * A replacement of the same kind must read the account the saved key does: both keys' last
		 * closed days must match. A saved key Morph no longer takes (revoked in a rotation) leaves
		 * nothing to compare, so the replacement is taken on trust.
		 */
		const sameAccount = Effect.fnUntraced(function* (
			orgId: OrgId,
			secret: Redacted.Redacted,
			account: MorphUsage.AccountUsage["account"],
		) {
			const saved = yield* connections.current(orgId, "morph").pipe(Effect.mapError(toPersistenceError))
			if (
				Option.isNone(saved) ||
				saved.value.accountId !== account ||
				Redacted.value(saved.value.secret) === Redacted.value(secret)
			) {
				return
			}
			const now = yield* Clock.currentTimeMillis
			const yesterday = addDays(utcToday(now), -1)
			const range = { start: addDays(yesterday, 1 - FINGERPRINT_DAYS), end: yesterday }
			const read = (key: Redacted.Redacted) =>
				MorphUsage.getUsage(httpClient, key, range).pipe(
					Effect.timeoutOrElse({
						duration: VALIDATE_TIMEOUT,
						orElse: () =>
							Effect.fail(
								new MorphUsage.MorphUsageError({
									message: "Morph timed out",
									kind: "upstream",
								}),
							),
					}),
				)
			const before = yield* read(saved.value.secret).pipe(
				Effect.asSome,
				Effect.catchTag("@maple/backend/cost/MorphUsageError", (error) =>
					error.kind === "unauthorized" ? Effect.succeedNone : Effect.fail(toKeyError(error)),
				),
			)
			if (Option.isNone(before)) return
			const after = yield* read(secret).pipe(Effect.mapError(toKeyError))
			if (fingerprint(before.value) !== fingerprint(after)) {
				return yield* refused(
					"This key reads another Morph account than the source does. Remove the source first to switch accounts.",
				)
			}
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
			const usage = yield* MorphUsage.getUsage(httpClient, secret).pipe(
				Effect.mapError(toKeyError),
				Effect.timeoutOrElse({ duration: VALIDATE_TIMEOUT, orElse: unreachable }),
			)
			yield* Effect.annotateCurrentSpan("maple.cost.morph.account", usage.account)
			yield* sameAccount(orgId, secret, usage.account)
			const account = { accountId: usage.account, accountLabel: ACCOUNT_LABELS[usage.account] }
			const saved = yield* connections
				.save({ orgId, userId, provider: "morph", secret, ...account })
				.pipe(Effect.mapError(toPersistenceError))
			if (saved === "other_account") {
				return yield* refused(
					usage.account === "personal"
						? "This is a personal key, and the source reads a Morph organization. Use one of the organization's keys, or remove the source first."
						: "This is an organization key, and the source reads a personal Morph account. Use a key of that account, or remove the source first.",
				)
			}
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
