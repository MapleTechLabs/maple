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
import { Context, Duration, Effect, Layer, Redacted, String as Str } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { CostConnectionStore, type CostConnectionStoreError } from "./CostConnectionStore"
import * as MorphUsage from "./providers/morph/morph-usage-api"

const VALIDATE_TIMEOUT = Duration.seconds(20)
/** Morph names no account, only its kind: every key of one kind reads one account. */
const ACCOUNT_LABELS = { organization: "Organization", personal: "Personal account" } as const

const refused = (message: string) => new CostConnectionValidationError({ message })

const toKeyError = (
	error: MorphUsage.MorphUsageError,
): CostConnectionValidationError | CostConnectionPersistenceError =>
	error.kind === "unauthorized"
		? refused("Morph rejected this key. Create one at morphllm.com/dashboard/api-keys.")
		: new CostConnectionPersistenceError({ message: "Could not check this key with Morph. Try again." })

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
			yield* Effect.annotateCurrentSpan("maple.cost.morph.account", usage.account)
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
