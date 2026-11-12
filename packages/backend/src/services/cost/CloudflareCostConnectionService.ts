// The Cloudflare API token an org's Cloudflare charges are read with: checked with Cloudflare, then
// kept in the shared cost connection store. Saving it makes the org's Cloudflare cost source,
// replacing it keeps the source and its history, removing it removes the source.
import {
	CLOUDFLARE_COST_TOKEN_MAX_LENGTH,
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
import * as CloudflareBilling from "./providers/cloudflare/cloudflare-billing-api"
import { addDays, utcToday } from "./sync-plan"

const VALIDATE_TIMEOUT = Duration.seconds(20)

const NO_BILLING_ACCESS =
	"This token cannot read the account's billing. Create a custom token with the Billing: Read permission."

const refused = (message: string) => new CostConnectionValidationError({ message })

/** Which call of the check failed decides what a 403 means: the token itself, or its permission. */
const toTokenError =
	(step: "accounts" | "billing") =>
	(
		error: CloudflareBilling.CloudflareBillingError,
	): CostConnectionValidationError | CostConnectionPersistenceError => {
		// Listing accounts answers 403 for a token Cloudflare does not know, where billing answers 401.
		if (error.kind === "unauthorized" || (error.kind === "forbidden" && step === "accounts")) {
			return refused("Cloudflare rejected this token.")
		}
		if (error.kind === "forbidden") return refused(NO_BILLING_ACCESS)
		return new CostConnectionPersistenceError({
			message: "Could not check this token with Cloudflare. Try again.",
		})
	}

const toPersistenceError = (error: CostConnectionStoreError) =>
	new CostConnectionPersistenceError({ message: error.message })

/** Printable and unbroken, as every Cloudflare token is: nothing else is ever sent as one. */
const couldBeToken = (token: string): boolean =>
	token.length <= CLOUDFLARE_COST_TOKEN_MAX_LENGTH && /^[\x21-\x7e]+$/.test(token)

export interface CloudflareCostConnectionServiceApi {
	/** Saves the token and answers the Cloudflare account it reads. */
	readonly set: (
		orgId: OrgId,
		userId: UserId,
		apiToken: string,
	) => Effect.Effect<
		{ readonly accountId: string; readonly accountLabel: string },
		CostConnectionPersistenceError | CostConnectionValidationError | CloudCostDisabledError
	>
	readonly remove: (orgId: OrgId) => Effect.Effect<void, CostConnectionPersistenceError>
}

export class CloudflareCostConnectionService extends Context.Service<
	CloudflareCostConnectionService,
	CloudflareCostConnectionServiceApi
>()("@maple/backend/services/cost/CloudflareCostConnectionService", {
	make: Effect.gen(function* () {
		const connections = yield* CostConnectionStore
		const featureFlags = yield* OrganizationFeatureFlagsService
		const httpClient = yield* HttpClient.HttpClient

		const asked = <A>(
			step: "accounts" | "billing",
			call: Effect.Effect<A, CloudflareBilling.CloudflareBillingError>,
		) => Effect.mapError(call, toTokenError(step))

		/**
		 * The one account the token reads, once it has proved it can read that account's billing:
		 * a token that cannot would save and then fail every sync.
		 */
		const validateWithCloudflare = Effect.fn("CloudflareCostConnectionService.validateWithCloudflare")(
			function* (token: Redacted.Redacted) {
				const { accounts, total } = yield* asked(
					"accounts",
					CloudflareBilling.listAccounts(httpClient, token),
				)
				const [account] = accounts
				// A token for several accounts would make one source of whichever is listed first.
				if (account === undefined || total !== 1) {
					return yield* refused(
						`This token can read ${total} accounts. Create one limited to a single account.`,
					)
				}
				const info = yield* asked(
					"billing",
					CloudflareBilling.getBillableUsageInfo(httpClient, token, account.id),
				)
				if (!info.covered) {
					return yield* refused(CloudflareBilling.NOT_COVERED)
				}
				const now = yield* Clock.currentTimeMillis
				// Yesterday is the newest day Cloudflare serves.
				const yesterday = addDays(utcToday(now), -1)
				yield* asked(
					"billing",
					CloudflareBilling.getBillableUsage(httpClient, token, account.id, {
						startDay: yesterday,
						endDay: yesterday,
					}),
				)
				return { accountId: account.id, accountLabel: account.name }
			},
		)

		const set = Effect.fn("CloudflareCostConnectionService.set")(function* (
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
			const apiToken = Str.trim(rawToken)
			if (!couldBeToken(apiToken)) {
				return yield* refused("That is not a Cloudflare API token.")
			}
			const secret = Redacted.make(apiToken)
			const account = yield* validateWithCloudflare(secret).pipe(
				Effect.timeoutOrElse({
					duration: VALIDATE_TIMEOUT,
					orElse: () =>
						Effect.fail(
							new CostConnectionPersistenceError({
								message: "Could not reach Cloudflare to check this token. Try again.",
							}),
						),
				}),
			)
			const saved = yield* connections
				.save({ orgId, userId, provider: "cloudflare", secret, ...account })
				.pipe(Effect.mapError(toPersistenceError))
			if (saved === "other_account") {
				return yield* refused(
					"This token reads another Cloudflare account than the source does. Remove the source first to switch accounts.",
				)
			}
			return account
		})

		const remove = Effect.fn("CloudflareCostConnectionService.remove")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			yield* connections.remove(orgId, "cloudflare").pipe(Effect.mapError(toPersistenceError))
		})

		return { set, remove } satisfies CloudflareCostConnectionServiceApi
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
