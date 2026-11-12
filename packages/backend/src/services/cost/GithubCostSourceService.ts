/**
 * GitHub cost sources: an org's GitHub organizations whose billing report Maple reads. The org
 * picks one of the GitHub App installations it already has; adding makes the `cost_sources` row,
 * removing deletes it. No credential is kept: pulls mint the installation's token.
 */
import {
	CloudCostDisabledError,
	GithubCostInstallation,
	type GithubCostInstallationState,
	GithubCostInstallationNotFoundError,
	GithubCostNotReadyError,
	GithubCostPermissionMissingError,
	GithubCostUnavailableError,
	type OrgId,
} from "@maple/domain/http"
import type { VcsInstallationId } from "@maple/domain/vcs"
import * as PG from "@maple-dev/effect-orm/postgres"
import { CostSources, type VcsInstallationRow, VcsInstallations } from "@maple/db/tables"
import { CostSourceId } from "@maple/primitives"
import { Array as Arr, Clock, Context, Duration, Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { VcsProviderRegistry } from "@maple/backend/services/integrations/vcs/VcsProviderRegistry"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import type { CostProviderError } from "./CostProvider"
import { monthOf, needsBillingGrant, readUsageMonth } from "./providers/github/billing-usage"
import { utcToday } from "./sync-plan"

const CHECK_TIMEOUT = Duration.seconds(20)

const USER_ACCOUNT =
	"Only organization accounts have a billing report. This installation is on a user account."

const INACTIVE = "This GitHub installation is suspended or was removed. Reconnect GitHub first."

const toUnavailable = makePersistenceErrorMapper(
	GithubCostUnavailableError,
	"GitHub cost source persistence failure",
)

/** A failed billing read, as what the Cost page shows next to the installation. */
const toAddError = (
	error: CostProviderError,
): GithubCostPermissionMissingError | GithubCostNotReadyError | GithubCostUnavailableError => {
	if (needsBillingGrant(error)) return new GithubCostPermissionMissingError({ message: error.message })
	return error.reason === "not_ready" || error.reason === "auth"
		? new GithubCostNotReadyError({ message: error.message })
		: new GithubCostUnavailableError({ message: error.message })
}

type Installation = Pick<
	VcsInstallationRow,
	"id" | "accountLogin" | "accountType" | "status" | "externalInstallationId"
>

/** Why an installation that is not a source yet can or cannot become one. */
const stateOf = (installation: Installation): Exclude<GithubCostInstallationState, "added"> =>
	installation.accountType !== "organization"
		? "user_account"
		: installation.status !== "active"
			? "inactive"
			: "available"

export interface GithubCostSourceServiceApi {
	/** The org's GitHub installations, with whether each can be a cost source or already is one. */
	readonly list: (
		orgId: OrgId,
	) => Effect.Effect<
		ReadonlyArray<GithubCostInstallation>,
		GithubCostUnavailableError | CloudCostDisabledError
	>
	/**
	 * Makes the installation's cost source once GitHub has let Maple read its billing report.
	 * `created` is false when it was a source already.
	 */
	readonly add: (
		orgId: OrgId,
		installationId: VcsInstallationId,
	) => Effect.Effect<
		{ readonly accountLogin: string; readonly created: boolean },
		| GithubCostUnavailableError
		| GithubCostInstallationNotFoundError
		| GithubCostNotReadyError
		| GithubCostPermissionMissingError
		| CloudCostDisabledError
	>
	/** The organization of the source it removed, or null when there was none. */
	readonly remove: (
		orgId: OrgId,
		installationId: VcsInstallationId,
	) => Effect.Effect<{ readonly accountLogin: string | null }, GithubCostUnavailableError>
}

export class GithubCostSourceService extends Context.Service<
	GithubCostSourceService,
	GithubCostSourceServiceApi
>()("@maple/backend/services/cost/GithubCostSourceService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const featureFlags = yield* OrganizationFeatureFlagsService
		const registry = yield* VcsProviderRegistry
		// The registry always has GitHub: a miss is a broken build, not a request's failure.
		const github = yield* Effect.orDie(registry.resolve("github"))
		const dbExecute = makeDbExecute(database, "GithubCostSourceService", toUnavailable)

		const requireRollout = Effect.fnUntraced(function* (orgId: OrgId) {
			const flags = yield* featureFlags.flags(orgId)
			if (!flags.cloudCost) {
				return yield* new CloudCostDisabledError({
					message: "Cloud cost is not enabled for this organization.",
				})
			}
		})

		const list = Effect.fn("GithubCostSourceService.list")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			yield* requireRollout(orgId)
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(VcsInstallations, "i")
						.leftJoin(CostSources, "s", (installation, source) =>
							source.orgId
								.eq(installation.orgId)
								.and(source.provider.eq("github"))
								.and(source.connectionRef.eq(installation.id)),
						)
						.select(($) => ({
							id: $.id,
							accountLogin: $.accountLogin,
							accountType: $.accountType,
							status: $.status,
							externalInstallationId: $.externalInstallationId,
							sourceId: $.s.id,
						}))
						.where(($) => [$.orgId.eq(orgId), $.provider.eq("github")])
						.orderBy(["accountLogin", "asc"], ["id", "asc"]),
				),
			)
			return Arr.map(
				rows,
				(row) =>
					new GithubCostInstallation({
						installationId: row.id,
						accountLogin: row.accountLogin,
						state: row.sourceId === null ? stateOf(row) : "added",
						settingsUrl: github.installationSettingsUrl(row),
					}),
			)
		})

		const add = Effect.fn("GithubCostSourceService.add")(function* (
			orgId: OrgId,
			installationId: VcsInstallationId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.cost.provider": "github" })
			yield* requireRollout(orgId)
			// By org as well as id: another org's installation is not found.
			const [installation] = yield* dbExecute((db) =>
				db.run(
					PG.from(VcsInstallations)
						.select(($) => ({
							id: $.id,
							accountLogin: $.accountLogin,
							accountType: $.accountType,
							status: $.status,
							externalInstallationId: $.externalInstallationId,
						}))
						.where(($) => [$.orgId.eq(orgId), $.id.eq(installationId), $.provider.eq("github")])
						.limit(1),
				),
			)
			if (installation === undefined) {
				return yield* new GithubCostInstallationNotFoundError({
					message: "This GitHub installation is not connected to the organization.",
				})
			}
			const state = stateOf(installation)
			if (state !== "available") {
				return yield* new GithubCostNotReadyError({
					message: state === "user_account" ? USER_ACCOUNT : INACTIVE,
				})
			}
			// One read of the current month: a missing permission is refused here, not at every sync.
			const now = yield* Clock.currentTimeMillis
			yield* readUsageMonth(github, installation, monthOf(utcToday(now))).pipe(
				// The page shows the mapped message; which failure it was stays on the span.
				Effect.tapError((error) =>
					Effect.annotateCurrentSpan("maple.cost.error_reason", error.reason),
				),
				Effect.mapError(toAddError),
				Effect.timeoutOrElse({
					duration: CHECK_TIMEOUT,
					orElse: () =>
						Effect.fail(
							new GithubCostUnavailableError({ message: "GitHub took too long to answer." }),
						),
				}),
			)
			const inserted = yield* dbExecute((db) =>
				db.run(
					PG.insertInto(CostSources)
						.values({
							id: CostSourceId.make(randomUUID()),
							orgId,
							provider: "github",
							connectionRef: installation.id,
							accountId: installation.accountLogin,
							createdAt: now,
							updatedAt: now,
						})
						// It is a source already: adding again changes nothing.
						.onConflictDoNothing()
						.returning(($) => ({ id: $.id })),
				),
			)
			return { accountLogin: installation.accountLogin, created: inserted.length > 0 }
		})

		const remove = Effect.fn("GithubCostSourceService.remove")(function* (
			orgId: OrgId,
			installationId: VcsInstallationId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.cost.provider": "github" })
			const removed = yield* dbExecute((db) =>
				db.run(
					PG.deleteFrom(CostSources)
						.where(($) => [
							$.orgId.eq(orgId),
							$.provider.eq("github"),
							$.connectionRef.eq(installationId),
						])
						.returning(($) => ({ accountId: $.accountId })),
				),
			)
			return { accountLogin: removed[0]?.accountId ?? null }
		})

		return { list, add, remove } satisfies GithubCostSourceServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(VcsProviderRegistry.layer, OrganizationFeatureFlagsService.layer)),
	)
}
