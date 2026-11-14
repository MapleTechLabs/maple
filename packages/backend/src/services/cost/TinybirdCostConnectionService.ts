// The Tinybird token an org's Tinybird usage is read with: checked with Tinybird, then kept in the
// shared cost connection store. Live: `/v0/sql` reads the organization's service data sources only
// with WORKSPACE:READ_ALL and ORG_DATASOURCES:READ together, or an org admin's workspace admin token.
import {
	CloudCostDisabledError,
	CostConnectionPersistenceError,
	CostConnectionValidationError,
	type OrgId,
	TINYBIRD_COST_TOKEN_MAX_LENGTH,
	type UserId,
} from "@maple/domain/http"
import { Context, Duration, Effect, Layer, Option, Redacted, String as Str } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { CostConnectionStore, type CostConnectionStoreError } from "./CostConnectionStore"
import * as TinybirdCost from "./providers/tinybird/tinybird-cost-api"

const VALIDATE_TIMEOUT = Duration.seconds(20)

const refused = (message: string) => new CostConnectionValidationError({ message })

const toTokenError = (
	error: TinybirdCost.TinybirdHostError,
): CostConnectionValidationError | CostConnectionPersistenceError => {
	switch (error.kind) {
		case "rejected":
			return refused("Tinybird rejected this token.")
		case "no_scope":
			return refused(
				"This token cannot read the organization's usage. Create one with the WORKSPACE:READ_ALL and ORG_DATASOURCES:READ scopes.",
			)
		default:
			return new CostConnectionPersistenceError({
				message: "Could not check this token with Tinybird. Try again.",
			})
	}
}

const toPersistenceError = (error: CostConnectionStoreError) =>
	new CostConnectionPersistenceError({ message: error.message })

/** Shaped like a Tinybird token: anything else is never sent to Tinybird. */
const couldBeToken = (token: string): boolean =>
	token.length <= TINYBIRD_COST_TOKEN_MAX_LENGTH && /^p\.[\x21-\x7e]+$/.test(token)

export interface TinybirdCostConnectionServiceApi {
	/** Saves the token and answers the Tinybird organization it reads. */
	readonly set: (
		orgId: OrgId,
		userId: UserId,
		token: string,
	) => Effect.Effect<
		{ readonly accountId: string; readonly accountLabel: string },
		CostConnectionPersistenceError | CostConnectionValidationError | CloudCostDisabledError
	>
	readonly remove: (orgId: OrgId) => Effect.Effect<void, CostConnectionPersistenceError>
}

export class TinybirdCostConnectionService extends Context.Service<
	TinybirdCostConnectionService,
	TinybirdCostConnectionServiceApi
>()("@maple/backend/services/cost/TinybirdCostConnectionService", {
	make: Effect.gen(function* () {
		const connections = yield* CostConnectionStore
		const featureFlags = yield* OrganizationFeatureFlagsService
		const httpClient = yield* HttpClient.HttpClient

		/** The token's organization, once some host has answered it with the organization's usage. */
		const validateWithTinybird = Effect.fn("TinybirdCostConnectionService.validateWithTinybird")(
			function* (token: Redacted.Redacted) {
				const { identity } = yield* TinybirdCost.resolveHost(httpClient, token).pipe(
					Effect.mapError(toTokenError),
				)
				if (Option.isNone(identity)) {
					return yield* refused(
						"This Tinybird organization has no workspace yet, so there is nothing to read.",
					)
				}
				const { workspace_id, workspace_name, organization_name } = identity.value
				return {
					accountId: workspace_id,
					accountLabel: organization_name === "" ? workspace_name : organization_name,
				}
			},
		)

		const set = Effect.fn("TinybirdCostConnectionService.set")(function* (
			orgId: OrgId,
			userId: UserId,
			rawToken: string,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const flags = yield* featureFlags.flags(orgId)
			if (!flags.cloudCost) {
				return yield* new CloudCostDisabledError({
					message: "Cloud cost is not enabled for this organization.",
				})
			}
			const token = Str.trim(rawToken)
			if (!couldBeToken(token)) {
				return yield* refused("That is not a Tinybird token. They start with p.")
			}
			const secret = Redacted.make(token)
			const account = yield* validateWithTinybird(secret).pipe(
				Effect.timeoutOrElse({
					duration: VALIDATE_TIMEOUT,
					orElse: () =>
						Effect.fail(
							new CostConnectionPersistenceError({
								message: "Could not reach Tinybird to check this token. Try again.",
							}),
						),
				}),
			)
			const saved = yield* connections
				.save({ orgId, userId, provider: "tinybird", secret, ...account })
				.pipe(Effect.mapError(toPersistenceError))
			if (saved === "other_account") {
				return yield* refused(
					"This token belongs to another Tinybird organization than the source does. Remove the source first to switch organizations.",
				)
			}
			return account
		})

		const remove = Effect.fn("TinybirdCostConnectionService.remove")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			yield* connections.remove(orgId, "tinybird").pipe(Effect.mapError(toPersistenceError))
		})

		return { set, remove } satisfies TinybirdCostConnectionServiceApi
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
