/**
 * The PlanetScale service token an org's PlanetScale invoices are read with: checked with
 * PlanetScale, then kept in the shared cost connection store. Saving it makes the org's PlanetScale
 * cost source, replacing it keeps the source and its history, removing it removes the source.
 */
import {
	CloudCostDisabledError,
	CostConnectionPersistenceError,
	CostConnectionValidationError,
	type OrgId,
	PLANETSCALE_COST_ORGANIZATION_MAX_LENGTH,
	PLANETSCALE_COST_TOKEN_ID_MAX_LENGTH,
	PLANETSCALE_COST_TOKEN_MAX_LENGTH,
	type UserId,
} from "@maple/domain/http"
import { Context, Duration, Effect, Layer, Array as Arr, String as Str } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { CostConnectionStore, type CostConnectionStoreError } from "./CostConnectionStore"
import {
	listInvoiceLineItems,
	listInvoices,
	type PlanetScaleInvoiceApiError,
	type PlanetScaleInvoiceCredentials,
	serviceTokenAuthorization,
} from "./providers/planetscale/invoices-api"

const VALIDATE_TIMEOUT = Duration.seconds(20)

const TOKEN_PREFIX = "pscale_tkn_"

const NO_INVOICE_ACCESS =
	"This service token cannot read invoices. Add the read_invoices organization access to it in PlanetScale."

// PlanetScale answers 404 for a token it does not know as well as for an organization the token cannot see.
const NOT_FOUND =
	"PlanetScale found no organization with this name for this service token. Check the organization, the token ID and the token."

const refused = (message: string) => new CostConnectionValidationError({ message })

const toTokenError = (
	error: PlanetScaleInvoiceApiError,
): CostConnectionValidationError | CostConnectionPersistenceError => {
	switch (error.reason) {
		case "unauthorized":
			return refused("PlanetScale rejected this service token.")
		case "forbidden":
			return refused(NO_INVOICE_ACCESS)
		case "not_found":
			return refused(NOT_FOUND)
		default:
			return new CostConnectionPersistenceError({
				message: "Could not check this token with PlanetScale. Try again.",
			})
	}
}

const toPersistenceError = (error: CostConnectionStoreError) =>
	new CostConnectionPersistenceError({ message: error.message })

/** A name as it stands in `app.planetscale.com/<organization>`: nothing else is put in a request path. */
const couldBeOrganization = (organization: string): boolean =>
	organization.length <= PLANETSCALE_COST_ORGANIZATION_MAX_LENGTH &&
	/^[a-z0-9][a-z0-9_-]*$/.test(organization)

/** The ID is the part of the header before the colon, so it holds none. */
const couldBeTokenId = (tokenId: string): boolean =>
	tokenId.length <= PLANETSCALE_COST_TOKEN_ID_MAX_LENGTH && /^[A-Za-z0-9_-]+$/.test(tokenId)

/** Printable and unbroken, as every service token is: nothing else is ever sent as one. */
const couldBeToken = (token: string): boolean =>
	token.length <= PLANETSCALE_COST_TOKEN_MAX_LENGTH &&
	Str.startsWith(TOKEN_PREFIX)(token) &&
	/^[\x21-\x7e]+$/.test(token)

export interface PlanetScaleCostTokenInput {
	readonly organization: string
	readonly tokenId: string
	readonly token: string
}

export interface PlanetScaleCostConnectionServiceApi {
	/** Saves the token and answers the PlanetScale organization it reads. */
	readonly set: (
		orgId: OrgId,
		userId: UserId,
		input: PlanetScaleCostTokenInput,
	) => Effect.Effect<
		{ readonly accountId: string; readonly accountLabel: string },
		CostConnectionPersistenceError | CostConnectionValidationError | CloudCostDisabledError
	>
	readonly remove: (orgId: OrgId) => Effect.Effect<void, CostConnectionPersistenceError>
}

export class PlanetScaleCostConnectionService extends Context.Service<
	PlanetScaleCostConnectionService,
	PlanetScaleCostConnectionServiceApi
>()("@maple/backend/services/cost/PlanetScaleCostConnectionService", {
	make: Effect.gen(function* () {
		const connections = yield* CostConnectionStore
		const featureFlags = yield* OrganizationFeatureFlagsService
		const httpClient = yield* HttpClient.HttpClient

		const asked = <A>(call: Effect.Effect<A, PlanetScaleInvoiceApiError>) =>
			call.pipe(
				// The page shows the mapped message; which failure it was stays on the span.
				Effect.tapError((error) =>
					Effect.annotateCurrentSpan({
						"maple.cost.planetscale.error": error.reason,
						"maple.cost.planetscale.status": error.status,
					}),
				),
				Effect.mapError(toTokenError),
			)

		/**
		 * Proves the token reads the organization's invoices and their line items: a token that
		 * cannot would save and then fail every sync. One page of each is proof enough.
		 */
		const validateWithPlanetScale = Effect.fn("PlanetScaleCostConnectionService.validateWithPlanetScale")(
			function* (credentials: PlanetScaleInvoiceCredentials) {
				const invoices = yield* asked(listInvoices(httpClient, credentials, () => true))
				yield* Effect.annotateCurrentSpan("maple.cost.planetscale.invoices", invoices.length)
				// An organization that was never invoiced has nothing more to read, and is still a source.
				yield* Effect.forEach(Arr.take(invoices, 1), (newest) =>
					asked(listInvoiceLineItems(httpClient, credentials, newest.id, () => true)),
				)
			},
		)

		const set = Effect.fn("PlanetScaleCostConnectionService.set")(function* (
			orgId: OrgId,
			userId: UserId,
			input: PlanetScaleCostTokenInput,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const flags = yield* featureFlags.flags(orgId)
			if (!flags.cloudCost) {
				return yield* new CloudCostDisabledError({
					message: "Cloud cost is not enabled for this organization.",
				})
			}
			// PlanetScale's names are lowercase: one organization is one account however it is typed.
			const organization = Str.toLowerCase(Str.trim(input.organization))
			const tokenId = Str.trim(input.tokenId)
			const token = Str.trim(input.token)
			if (!couldBeOrganization(organization)) {
				return yield* refused(
					"That is not a PlanetScale organization name. Use the name in app.planetscale.com/<organization>.",
				)
			}
			if (!couldBeTokenId(tokenId)) return yield* refused("That is not a service token ID.")
			if (!couldBeToken(token)) {
				return yield* refused(
					`That is not a PlanetScale service token. They start with ${TOKEN_PREFIX}.`,
				)
			}
			const secret = serviceTokenAuthorization(tokenId, token)
			yield* validateWithPlanetScale({ organization, authorization: secret }).pipe(
				Effect.timeoutOrElse({
					duration: VALIDATE_TIMEOUT,
					orElse: () =>
						Effect.fail(
							new CostConnectionPersistenceError({
								message: "Could not reach PlanetScale to check this token. Try again.",
							}),
						),
				}),
			)
			// The organization is the account: its name is all PlanetScale's invoices say about it.
			const account = { accountId: organization, accountLabel: organization }
			const saved = yield* connections
				.save({ orgId, userId, provider: "planetscale", secret, ...account })
				.pipe(Effect.mapError(toPersistenceError))
			if (saved === "other_account") {
				return yield* refused(
					"The source reads another PlanetScale organization. Remove the source first to switch organizations.",
				)
			}
			return account
		})

		const remove = Effect.fn("PlanetScaleCostConnectionService.remove")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			yield* connections.remove(orgId, "planetscale").pipe(Effect.mapError(toPersistenceError))
		})

		return { set, remove } satisfies PlanetScaleCostConnectionServiceApi
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
