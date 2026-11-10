import { Predicate, Array as Arr, String as Str } from "effect"
import { isMissingWarehouseTable } from "@maple/query-engine"
import * as Datasources from "@maple/domain/tinybird/datasources"

/**
 * Detect "this table is missing on the org's cluster" so a caller can read a
 * raw-source equivalent (or degrade) instead of 502ing.
 *
 * Rollup and newer tables (`product_events` since migration 0016, the
 * `service_operations_*` rollups) ship in `requiredForIngest: false`
 * migrations, which reach a BYO-ClickHouse cluster only when an org admin
 * clicks Apply schema: nothing reconciles that, so the window where an org
 * lacks one is unbounded, per-org, and invisible from here. The only correct
 * response is to notice at query time, with `isMissingWarehouseTable`.
 */

const MISSING_TABLE_NAME =
	/Resource '([^']+)' not found|Unknown table expression identifier '([^']+)'|Table (\S+) does not exist/i

/**
 * The table a `WarehouseConfigError` says is missing, when it says so; undefined for every other
 * error. A table that is not deployed yet (deploy ordering, an unapplied BYO schema) clears later.
 */
export const missingWarehouseTable = (error: unknown): string | undefined => {
	if (!Predicate.isTagged(error, "@maple/http/errors/WarehouseConfigError")) return undefined
	const message = Predicate.hasProperty(error, "message") ? error.message : undefined
	const match = Predicate.isString(message) ? MISSING_TABLE_NAME.exec(message) : null
	const name = match?.[1] ?? match?.[2] ?? match?.[3]
	return name === undefined ? undefined : Arr.lastNonEmpty(Str.split(".")(name))
}

/**
 * Only page-view queries may degrade on this one: raw `session_events` holds
 * the same browser rows. Funnels have no raw counterpart (server and mobile
 * rows exist only in `product_events`) and must surface the error.
 */
export const isMissingProductEvents = isMissingWarehouseTable(Datasources.productEvents)

/** `ai_crawler_requests` ships in a later migration; only its absence may drop the crawler stats. */
export const isMissingAiCrawlerRequests = isMissingWarehouseTable(Datasources.aiCrawlerRequests)

/** `ci_runs` / `ci_jobs` ship in migration 0047; the CI reads have no raw fallback. */
export const isMissingCiTables = isMissingWarehouseTable(Datasources.ciRuns, Datasources.ciJobs)

export const isMissingServiceOperationsRollup = isMissingWarehouseTable(
	Datasources.serviceOperationsMinutely,
	Datasources.serviceOperationsHourly,
)

/** `service_map_db_edges_minutely` ships in migration 0049; the map's DB edges then read raw traces. */
export const isMissingServiceMapDbEdgesMinutely = isMissingWarehouseTable(
	Datasources.serviceMapDbEdgesMinutely,
)

/** `service_endpoint_details_hourly` ships in migration 0048; the endpoint detail reads degrade to empty. */
export const isMissingServiceEndpointDetails = isMissingWarehouseTable(
	Datasources.serviceEndpointDetailsHourly,
)

/** `user_activity_hourly` (migration 0056) is missing; the users pages degrade. */
export const isMissingUserActivityHourly = isMissingWarehouseTable(Datasources.userActivityHourly)

const MIGRATION_0048_COLUMNS =
	/\b(?:HttpClassifiedSpanCount|HttpStatusCount|Http4xxCount|Http5xxCount|RequestBodyBytes|RequestBodyCount)\b/

/**
 * The operations rollups exist but predate migration 0048's HTTP columns: a Maple-authored
 * query naming one of them is classified as schema drift. The service API reads fall back to
 * raw traces then, exactly as for a missing rollup.
 */
export const isMissingServiceApiColumns = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	error._tag === "@maple/http/errors/WarehouseSchemaDriftError" &&
	"message" in error &&
	typeof error.message === "string" &&
	MIGRATION_0048_COLUMNS.test(error.message)

/** `user_activity_hourly` predates its request channel counts (migration 0058): schema drift naming
 * one of them. The directory then lists users without channels. */
export const isMissingUserActivityChannels = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	error._tag === "@maple/http/errors/WarehouseSchemaDriftError" &&
	"message" in error &&
	typeof error.message === "string" &&
	/\b(?:ClassifiedRequestCount|WebRequestCount|MobileRequestCount)\b/.test(error.message)

/** `error_events.UserId` (migration 0057) is missing: schema drift naming `UserId` only, so every
 * other drift still surfaces. User issues and affected users then answer unattributed. */
export const isMissingErrorEventsUserId = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	error._tag === "@maple/http/errors/WarehouseSchemaDriftError" &&
	"message" in error &&
	typeof error.message === "string" &&
	/\bUserId\b/.test(error.message)
