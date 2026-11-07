import { Array as Arr, Predicate, String as Str } from "effect"

/**
 * Detect "this table is missing on the org's cluster" so a caller can read a
 * raw-source equivalent (or degrade) instead of 502ing.
 *
 * Rollup and newer tables (`product_events` since migration 0016, the
 * `service_operations_*` rollups) ship in `requiredForIngest: false`
 * migrations, which reach a BYO-ClickHouse cluster only when an org admin
 * clicks Apply schema — nothing reconciles that, so the window where an org
 * lacks one is unbounded, per-org, and invisible from here. The only correct
 * response is to notice at query time.
 *
 * Matches the classified `WarehouseConfigError` (ClickHouse `UNKNOWN_TABLE`,
 * or the Tinybird gateway's "Resource '<name>' not found", which the query
 * engine classifies the same way) whose message names the table.
 */
const isMissingTable =
	(table: RegExp) =>
	(error: unknown): boolean => {
		if (typeof error !== "object" || error === null) return false
		const candidate = error as {
			readonly _tag?: unknown
			readonly clickhouseType?: unknown
			readonly message?: unknown
		}
		return (
			candidate._tag === "@maple/http/errors/WarehouseConfigError" &&
			(candidate.clickhouseType === "UNKNOWN_TABLE" ||
				(typeof candidate.message === "string" && table.test(candidate.message)))
		)
	}

const MISSING_TABLE_NAME =
	/Resource '([^']+)' not found|Unknown table expression identifier '([^']+)'|Table (\S+) does not exist/i

/**
 * The table a `WarehouseConfigError` says is missing, when it says so; undefined for every other
 * error. A table that is not deployed yet (deploy ordering, an unapplied BYO schema) clears later.
 */
export const missingWarehouseTable = (error: unknown): string | undefined => {
	if (!isMissingTable(MISSING_TABLE_NAME)(error) || !Predicate.hasProperty(error, "message"))
		return undefined
	const match = Predicate.isString(error.message) ? MISSING_TABLE_NAME.exec(error.message) : null
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
export const isMissingServiceMapDbEdgesMinutely = (error: unknown): boolean =>
	isMissingTable(/service_map_db_edges_minutely/i)(error) &&
	typeof error === "object" &&
	error !== null &&
	"message" in error &&
	typeof error.message === "string" &&
	/service_map_db_edges_minutely/i.test(error.message)

/** `service_endpoint_details_hourly` ships in migration 0048; the endpoint detail reads degrade to empty. */
export const isMissingServiceEndpointDetails = isMissingTable(/service_endpoint_details_hourly/i)

/** `user_activity_hourly` (migration 0056) is missing; the message must name it, as the users
 * pages' retry reads every other table. */
export const isMissingUserActivityHourly = (error: unknown): boolean =>
	isMissingTable(/user_activity_hourly/i)(error) &&
	typeof error === "object" &&
	error !== null &&
	"message" in error &&
	typeof error.message === "string" &&
	/user_activity_hourly/i.test(error.message)

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
