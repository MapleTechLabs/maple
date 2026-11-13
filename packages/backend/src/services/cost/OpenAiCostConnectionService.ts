// The OpenAI Admin API key an org's OpenAI spend is read with: checked with OpenAI, then kept in the
// shared cost connection store. Admin keys cannot be scoped to costs, which the Cost page says.
import {
	CloudCostDisabledError,
	CostConnectionPersistenceError,
	CostConnectionValidationError,
	OPENAI_COST_KEY_MAX_LENGTH,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import { Clock, Context, Duration, Effect, Layer, Redacted, Array as Arr, String as Str } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { CostConnectionStore, type CostConnectionStoreError } from "./CostConnectionStore"
import * as OpenAiCosts from "./providers/openai/openai-costs-api"
import { MAX_PULL_PAGES, unixDayStart } from "./providers/openai/OpenAiCostProvider"
import { addDays, utcToday } from "./sync-plan"

const VALIDATE_TIMEOUT = Duration.seconds(20)
/** Days of spend the check reads for the key's organization: one page of daily buckets. */
const VALIDATE_DAYS = 180

const refused = (message: string) => new CostConnectionValidationError({ message })

const toKeyError = (
	error: OpenAiCosts.OpenAiCostsError,
): CostConnectionValidationError | CostConnectionPersistenceError => {
	// OpenAI answers 400 for text that is not shaped like a key it knows.
	if (error.kind === "unauthorized" || error.kind === "bad_request") {
		return refused("OpenAI rejected this key. Use an Admin API key from the organization's settings.")
	}
	if (error.kind === "forbidden") {
		return refused("This key cannot read the organization's costs. Use an Admin API key.")
	}
	return new CostConnectionPersistenceError({ message: "Could not check this key with OpenAI. Try again." })
}

const toPersistenceError = (error: CostConnectionStoreError) =>
	new CostConnectionPersistenceError({ message: error.message })

/** An Admin API key: `sk-admin-` and printable text, unbroken. Nothing else is ever sent as one. */
const couldBeKey = (key: string): boolean =>
	key.length <= OPENAI_COST_KEY_MAX_LENGTH && /^sk-admin-[\x21-\x7e]+$/.test(key)

export interface OpenAiCostConnectionServiceApi {
	/** Saves the key and answers the OpenAI organization it reads. */
	readonly set: (
		orgId: OrgId,
		userId: UserId,
		apiKey: string,
	) => Effect.Effect<
		{ readonly accountId: string; readonly accountLabel: string },
		CostConnectionPersistenceError | CostConnectionValidationError | CloudCostDisabledError
	>
	readonly remove: (orgId: OrgId) => Effect.Effect<void, CostConnectionPersistenceError>
}

export class OpenAiCostConnectionService extends Context.Service<
	OpenAiCostConnectionService,
	OpenAiCostConnectionServiceApi
>()("@maple/backend/services/cost/OpenAiCostConnectionService", {
	make: Effect.gen(function* () {
		const connections = yield* CostConnectionStore
		const featureFlags = yield* OrganizationFeatureFlagsService
		const httpClient = yield* HttpClient.HttpClient

		/**
		 * The organization the key reads: the documented `openai-organization` header of the costs
		 * answer, else the one `organization_id` its results carry. No other OpenAI endpoint names it.
		 */
		const validateWithOpenAi = Effect.fn("OpenAiCostConnectionService.validateWithOpenAi")(function* (
			key: Redacted.Redacted,
		) {
			const now = yield* Clock.currentTimeMillis
			const tomorrow = addDays(utcToday(now), 1)
			const listing = yield* OpenAiCosts.listCosts(
				httpClient,
				key,
				{
					startTime: unixDayStart(addDays(tomorrow, -VALIDATE_DAYS)),
					endTime: unixDayStart(tomorrow),
					groupBy: [],
				},
				MAX_PULL_PAGES,
			).pipe(Effect.mapError(toKeyError))
			const fromResults = Arr.dedupe(
				Arr.flatMap(listing.buckets, (bucket) =>
					Arr.flatMap(bucket.results, (result) =>
						result.organization_id === undefined ||
						result.organization_id === null ||
						result.organization_id === ""
							? []
							: [result.organization_id],
					),
				),
			)
			const charges = Arr.some(listing.buckets, (bucket) => Arr.isReadonlyArrayNonEmpty(bucket.results))
			yield* Effect.annotateCurrentSpan({
				"maple.cost.openai.pages": listing.pages,
				"maple.cost.openai.organization_header": listing.organization !== undefined,
				"maple.cost.openai.organizations": fromResults.length,
				"maple.cost.openai.has_results": charges,
			})
			// The documented `openai-organization` header first; else the one organization the results name.
			if (listing.organization !== undefined) {
				return { accountId: listing.organization, accountLabel: listing.organization }
			}
			// Results of two organizations leave no telling which one the key belongs to.
			if (fromResults.length > 1) {
				return yield* refused(
					"OpenAI reports costs of more than one organization for this key, so Maple cannot tell which one it reads.",
				)
			}
			const [organization] = fromResults
			if (organization === undefined) {
				return yield* refused(
					charges
						? "OpenAI did not say which organization this key belongs to, so Maple cannot add it yet."
						: "This OpenAI organization has no API spend in the last 180 days, so there is nothing to read yet.",
				)
			}
			return { accountId: organization, accountLabel: organization }
		})

		const set = Effect.fn("OpenAiCostConnectionService.set")(function* (
			orgId: OrgId,
			userId: UserId,
			rawKey: string,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const flags = yield* featureFlags.flags(orgId)
			if (!flags.cloudCost) {
				return yield* new CloudCostDisabledError({
					message: "Cloud cost is not enabled for this organization.",
				})
			}
			const apiKey = Str.trim(rawKey)
			if (!couldBeKey(apiKey)) {
				return yield* refused("That is not an OpenAI Admin API key. They start with sk-admin-.")
			}
			const secret = Redacted.make(apiKey)
			const account = yield* validateWithOpenAi(secret).pipe(
				Effect.timeoutOrElse({
					duration: VALIDATE_TIMEOUT,
					orElse: () =>
						Effect.fail(
							new CostConnectionPersistenceError({
								message: "Could not reach OpenAI to check this key. Try again.",
							}),
						),
				}),
			)
			const saved = yield* connections
				.save({ orgId, userId, provider: "openai", secret, ...account })
				.pipe(Effect.mapError(toPersistenceError))
			if (saved === "other_account") {
				return yield* refused(
					"This key belongs to another OpenAI organization than the source does. Remove the source first to switch organizations.",
				)
			}
			return account
		})

		const remove = Effect.fn("OpenAiCostConnectionService.remove")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			yield* connections.remove(orgId, "openai").pipe(Effect.mapError(toPersistenceError))
		})

		return { set, remove } satisfies OpenAiCostConnectionServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				FetchHttpClient.layer,
				OrganizationFeatureFlagsService.layer,
				CostConnectionStore.layer,
			),
		),
	)
}
