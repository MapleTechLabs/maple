import { WarehouseConfigError, WarehouseSchemaDriftError } from "@maple/domain/http"
import { Array as Arr, Schema, String as Str } from "effect"

const isConfigError = Schema.is(WarehouseConfigError)
const isSchemaDrift = Schema.is(WarehouseSchemaDriftError)

/**
 * Detect "this table is missing on the org's cluster" so a caller can read a
 * raw-source equivalent (or degrade) instead of 502ing.
 *
 * Rollup and newer tables (`product_events` since migration 0016, the
 * `service_operations_*` rollups) ship in `requiredForIngest: false`
 * migrations, which reach a BYO-ClickHouse cluster only when an org admin
 * clicks Apply schema; nothing reconciles that, so the window where an org
 * lacks one is unbounded, per-org, and invisible from here. The only correct
 * response is to notice at query time.
 *
 * Matches the classified `WarehouseConfigError` (ClickHouse `UNKNOWN_TABLE`,
 * or the Tinybird gateway's "Resource '<name>' not found", which the query
 * engine classifies the same way) whose message names the table.
 */
const isMissingTable =
	(table: RegExp) =>
	(error: unknown): boolean =>
		isConfigError(error) && (error.clickhouseType === "UNKNOWN_TABLE" || table.test(error.message))

/** A missing-table error whose message names `table`, for reads whose retry touches every other table. */
const namesMissingTable =
	(table: RegExp) =>
	(error: unknown): boolean =>
		isConfigError(error) && table.test(error.message)

/** Schema drift whose message names one of `columns`, so every other drift still surfaces. */
const namesDriftedColumn =
	(columns: RegExp) =>
	(error: unknown): boolean =>
		isSchemaDrift(error) && columns.test(error.message)

const MISSING_TABLE_NAME =
	/Resource '([^']+)' not found|Unknown table expression identifier '([^']+)'|Table (\S+) does not exist/i

/**
 * The table a `WarehouseConfigError` says is missing, when it says so; undefined for every other
 * error. A table that is not deployed yet (deploy ordering, an unapplied BYO schema) clears later.
 */
export const missingWarehouseTable = (error: unknown): string | undefined => {
	if (!isConfigError(error) || !isMissingTable(MISSING_TABLE_NAME)(error)) return undefined
	const match = MISSING_TABLE_NAME.exec(error.message)
	const name = match?.[1] ?? match?.[2] ?? match?.[3]
	return name === undefined ? undefined : Arr.lastNonEmpty(Str.split(".")(name))
}

/**
 * Only page-view queries may degrade on this one — raw `session_events` holds
 * the same browser rows. Funnels have no raw counterpart (server and mobile
 * rows exist only in `product_events`) and must surface the error.
 */
export const isMissingProductEvents = isMissingTable(/product_events/i)

/** `ai_crawler_requests` ships in a later migration; only its absence may drop the crawler stats. */
export const isMissingAiCrawlerRequests = isMissingTable(/ai_crawler_requests/i)

/** `ci_runs` / `ci_jobs` ship in migration 0047; the CI reads have no raw fallback. */
export const isMissingCiTables = isMissingTable(/ci_(?:runs|jobs)/i)

export const isMissingServiceOperationsRollup = isMissingTable(/service_operations_(?:minutely|hourly)/i)

/**
 * `service_map_db_edges_minutely` ships in migration 0049; the map's DB edges then read raw traces.
 * The message must name it: the raw retry reads every other table, so any other missing one fails again.
 */
export const isMissingServiceMapDbEdgesMinutely = namesMissingTable(/service_map_db_edges_minutely/i)

/** `service_endpoint_details_hourly` ships in migration 0048; the endpoint detail reads degrade to empty. */
export const isMissingServiceEndpointDetails = isMissingTable(/service_endpoint_details_hourly/i)

/** `user_activity_hourly` (migration 0056) is missing; the message must name it, as the users
 * pages' retry reads every other table. */
export const isMissingUserActivityHourly = namesMissingTable(/user_activity_hourly/i)

const MIGRATION_0048_COLUMNS =
	/\b(?:HttpClassifiedSpanCount|HttpStatusCount|Http4xxCount|Http5xxCount|RequestBodyBytes|RequestBodyCount)\b/

/**
 * The operations rollups exist but predate migration 0048's HTTP columns: a Maple-authored
 * query naming one of them is classified as schema drift. The service API reads fall back to
 * raw traces then, exactly as for a missing rollup.
 */
export const isMissingServiceApiColumns = namesDriftedColumn(MIGRATION_0048_COLUMNS)

/** `user_activity_hourly` predates its request channel counts (migration 0058): schema drift naming
 * one of them. The directory then lists users without channels. */
export const isMissingUserActivityChannels = namesDriftedColumn(
	/\b(?:ClassifiedRequestCount|WebRequestCount|MobileRequestCount)\b/,
)

/** `error_events.UserId` (migration 0057) is missing: schema drift naming `UserId` only, so every
 * other drift still surfaces. User issues and affected users then answer unattributed. */
export const isMissingErrorEventsUserId = namesDriftedColumn(/\bUserId\b/)
