// The Anthropic Admin API key an org's Anthropic API spend is read with: checked with Anthropic,
// then kept in the shared cost connection store. Anthropic has no admin key limited to cost
// reads, so any Admin API key is accepted and the Cost page warns about its reach.
import {
	ANTHROPIC_COST_KEY_MAX_LENGTH,
	CloudCostDisabledError,
	CostConnectionPersistenceError,
	CostConnectionValidationError,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import { Clock, Context, Duration, Effect, Layer, Redacted, String as Str } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { CostConnectionStore, type CostConnectionStoreError } from "./CostConnectionStore"
import * as AnthropicCost from "./providers/anthropic/anthropic-cost-api"
import { addDays, utcToday } from "./sync-plan"

const VALIDATE_TIMEOUT = Duration.seconds(20)

const UNCHECKED = "Could not check this key with Anthropic. Try again."

const refused = (message: string) => new CostConnectionValidationError({ message })

/** Which call of the check failed decides what a refusal means: the key itself, or its access. */
const toKeyError =
	(step: "organization" | "costs") =>
	(
		error: AnthropicCost.AnthropicCostApiError,
	): CostConnectionValidationError | CostConnectionPersistenceError => {
		const rejected =
			error.kind === "unauthorized" || error.kind === "forbidden" || error.kind === "bad_request"
		if (step === "organization" && rejected) {
			return refused("Anthropic rejected this key. Use an Admin API key from the Claude Console.")
		}
		if (step === "costs" && error.kind === "forbidden") {
			return refused("This key cannot read the organization's costs. Use an Admin API key.")
		}
		return new CostConnectionPersistenceError({ message: UNCHECKED })
	}

const toPersistenceError = (error: CostConnectionStoreError) =>
	new CostConnectionPersistenceError({ message: error.message })

/** Shaped like an Admin API key: anything else is never sent to Anthropic. */
const couldBeAdminKey = (key: string): boolean =>
	key.length <= ANTHROPIC_COST_KEY_MAX_LENGTH && /^sk-ant-admin[\x21-\x7e]+$/.test(key)

export interface AnthropicCostConnectionServiceApi {
	/** Saves the key and answers the Anthropic organization it reads. */
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

export class AnthropicCostConnectionService extends Context.Service<
	AnthropicCostConnectionService,
	AnthropicCostConnectionServiceApi
>()("@maple/backend/services/cost/AnthropicCostConnectionService", {
	make: Effect.gen(function* () {
		const connections = yield* CostConnectionStore
		const featureFlags = yield* OrganizationFeatureFlagsService
		const httpClient = yield* HttpClient.HttpClient

		/** The key's organization, once the key has proved it reads that organization's cost report. */
		const validateWithAnthropic = Effect.fn("AnthropicCostConnectionService.validateWithAnthropic")(
			function* (key: Redacted.Redacted) {
				const organization = yield* AnthropicCost.getOrganization(httpClient, key).pipe(
					Effect.mapError(toKeyError("organization")),
				)
				const now = yield* Clock.currentTimeMillis
				const today = utcToday(now)
				yield* AnthropicCost.getCostReport(httpClient, key, {
					startDay: addDays(today, -1),
					endDay: today,
				}).pipe(Effect.mapError(toKeyError("costs")))
				return { accountId: organization.id, accountLabel: organization.name }
			},
		)

		const set = Effect.fn("AnthropicCostConnectionService.set")(function* (
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
			if (!couldBeAdminKey(apiKey)) {
				return yield* refused("That is not an Anthropic Admin API key. They start with sk-ant-admin.")
			}
			const secret = Redacted.make(apiKey)
			const account = yield* validateWithAnthropic(secret).pipe(
				Effect.timeoutOrElse({
					duration: VALIDATE_TIMEOUT,
					orElse: () =>
						Effect.fail(
							new CostConnectionPersistenceError({
								message: "Could not reach Anthropic to check this key. Try again.",
							}),
						),
				}),
			)
			const saved = yield* connections
				.save({ orgId, userId, provider: "anthropic", secret, ...account })
				.pipe(Effect.mapError(toPersistenceError))
			if (saved === "other_account") {
				return yield* refused(
					"This key belongs to another Anthropic organization than the source does. Remove the source first to switch organizations.",
				)
			}
			return account
		})

		const remove = Effect.fn("AnthropicCostConnectionService.remove")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			yield* connections.remove(orgId, "anthropic").pipe(Effect.mapError(toPersistenceError))
		})

		return { set, remove } satisfies AnthropicCostConnectionServiceApi
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
