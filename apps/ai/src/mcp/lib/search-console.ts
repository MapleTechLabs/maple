// Shared by the Search Console tools: which property to read, whether its import has data yet,
// the window (ending on the last complete day by default), and how read failures reach the model.
import { Clock, DateTime, Effect, Option, Array as Arr, String as Str } from "effect"
import { completeThrough, pacificToday } from "@maple/domain/search-console"
import { SearchConsoleService } from "@maple/backend/services/integrations/SearchConsoleService"
import { makeSearchConsoleReads } from "@maple/backend/queries/search-console-reads"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import type { SearchConsoleSiteRow } from "@maple/db/tables"
import type { SearchConsoleSiteState } from "@maple/domain/mcp-outputs"
import { parseWarehouseDateTime, warehouseDateTime, type WarehouseDateTime } from "@maple/query-engine"
import {
	McpInvalidInputError,
	McpNotReadyError,
	McpQueryBudgetError,
	McpQueryError,
	McpUnavailableError,
} from "../tools/types"
import { warehouseReadToMcpHandlers } from "./map-warehouse-error"
import { CurrentMcpTenant } from "./query-warehouse"

const DAY_MS = 86_400_000
/** The importer runs on the 15-minute alerting cron. */
const IMPORT_RETRY_SECONDS = 900
const CAPABILITY = "search_console"

/** `https://www.example.com/` and `sc-domain:example.com` both match `example.com`. */
const looseSite = (value: string): string =>
	Str.replace(
		/\/+$/,
		"",
	)(Str.replace(/^(?:sc-domain:|https?:\/\/)(?:www\.)?/, "")(Str.toLowerCase(Str.trim(value))))

const pickSite = (
	enabled: ReadonlyArray<SearchConsoleSiteRow>,
	requested: string,
): Option.Option<SearchConsoleSiteRow> =>
	Option.orElse(
		Arr.findFirst(enabled, (row) => row.siteUrl === requested),
		() => {
			const matches = Arr.filter(enabled, (row) => looseSite(row.siteUrl) === looseSite(requested))
			return matches.length === 1 ? Arr.head(matches) : Option.none()
		},
	)

export interface ResolvedSearchConsoleSite {
	readonly row: SearchConsoleSiteRow
	readonly state: typeof SearchConsoleSiteState.Type
}

/**
 * The enabled property to read: `requested` (exact, or the same host), else the first one with
 * imported data. Not connected is unavailable; a property whose first import has not landed is not ready.
 */
export const resolveSearchConsoleSite = Effect.fn("McpSearchConsole.resolveSite")(function* (
	tool: string,
	requested: string | undefined,
) {
	const tenant = yield* CurrentMcpTenant
	const service = yield* SearchConsoleService
	const status = yield* service
		.getStatus(tenant.orgId)
		.pipe(
			Effect.mapError(
				(error) => new McpQueryError({ message: error.message, pipeName: tool, cause: error }),
			),
		)
	if (status.connection === null) {
		return yield* new McpUnavailableError({
			message: status.configured
				? "Google Search Console is not connected for this organization. Connect it from Integrations in Maple, then pick the properties to import."
				: "This Maple deployment has no Google OAuth client, so Search Console cannot be connected.",
			capability: CAPABILITY,
		})
	}
	if (status.connection.revoked) {
		return yield* new McpUnavailableError({
			message:
				"The Google grant behind Search Console was revoked, so imports stopped. Reconnect Google from Integrations in Maple.",
			capability: CAPABILITY,
		})
	}
	const enabled = Arr.filter(status.sites, (row) => row.enabled)
	if (enabled.length === 0) {
		return yield* new McpUnavailableError({
			message:
				"Google is connected but no Search Console property is selected for import. Pick one from Integrations in Maple.",
			capability: CAPABILITY,
		})
	}
	const chosen =
		requested === undefined
			? Option.orElse(
					Arr.findFirst(enabled, (row) => row.watermarkDate !== null),
					() => Arr.head(enabled),
				)
			: pickSite(enabled, requested)
	if (Option.isNone(chosen)) {
		const sameHost = Arr.filter(enabled, (row) => looseSite(row.siteUrl) === looseSite(requested ?? ""))
		return yield* new McpInvalidInputError({
			message:
				sameHost.length > 1
					? `"${requested ?? ""}" matches several enabled Search Console properties: ${Arr.join(
							Arr.map(sameHost, (row) => row.siteUrl),
							", ",
						)}. Pass one of them exactly.`
					: `No enabled Search Console property matches "${requested ?? ""}". Enabled: ${Arr.join(
							Arr.map(enabled, (row) => row.siteUrl),
							", ",
						)}.`,
			parameter: "site",
		})
	}
	const row = chosen.value
	yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.search_console.site": row.siteUrl })
	if (row.watermarkDate === null) {
		return yield* new McpNotReadyError({
			message:
				row.lastError === null
					? `The first Search Console import for ${row.siteUrl} has not finished yet; it runs every 15 minutes.`
					: `The first Search Console import for ${row.siteUrl} has not succeeded yet. Google's last answer: ${row.lastError}`,
			retryAfterSeconds: IMPORT_RETRY_SECONDS,
		})
	}
	const now = yield* Clock.currentTimeMillis
	return {
		row,
		state: {
			siteUrl: row.siteUrl,
			// The last complete day: the import reaches today, whose numbers are still partial.
			dataThrough: completeThrough(row.watermarkDate, pacificToday(now)),
			lastSyncedAt:
				row.lastSyncedAt === null ? null : DateTime.formatIso(DateTime.makeUnsafe(row.lastSyncedAt)),
			lastError: row.lastError,
			otherSites: Arr.filter(
				Arr.map(enabled, (other) => other.siteUrl),
				(siteUrl) => siteUrl !== row.siteUrl,
			),
		},
	} satisfies ResolvedSearchConsoleSite
})

/** Midnight UTC of a `YYYY-MM-DD` day, NaN for anything else. */
const dayStartMs = (date: string): number => parseWarehouseDateTime(`${date} 00:00:00`)

/** With no explicit bounds the window ends on the last complete day, so deltas compare whole days. */
export const windowEndingAtDataThrough = <
	P extends {
		readonly start_time?: WarehouseDateTime | undefined
		readonly end_time?: WarehouseDateTime | undefined
	},
>(
	params: P,
	dataThrough: string | null,
): P => {
	if (dataThrough === null || params.start_time !== undefined || params.end_time !== undefined)
		return params
	const day = dayStartMs(dataThrough)
	return Number.isNaN(day) ? params : { ...params, end_time: warehouseDateTime(day + DAY_MS - 1000) }
}

/** The window's days after the last complete day, which the reads leave out. */
export const daysPastDataThrough = (endTime: string, dataThrough: string | null): number => {
	if (dataThrough === null) return 0
	const end = dayStartMs(Str.slice(0, 10)(endTime))
	const through = dayStartMs(dataThrough)
	return Number.isNaN(end) || Number.isNaN(through) ? 0 : Math.max(0, Math.round((end - through) / DAY_MS))
}

export const searchConsoleReads = Effect.gen(function* () {
	const warehouse = yield* WarehouseQueryService
	const queryEngine = yield* QueryEngineService
	return makeSearchConsoleReads({ warehouse, queryEngine })
})

/** `catchTags` handlers for the reads: a timeout is a budget error, warehouse failures as usual. */
export const searchConsoleReadHandlers = (tool: string) => ({
	"@maple/http/errors/QueryEngineTimeoutError": () =>
		Effect.fail(
			new McpQueryBudgetError({
				message: "The Search Console read ran past its time limit. Narrow start_time/end_time.",
				pipeName: tool,
				setting: "max_execution_time",
			}),
		),
	...warehouseReadToMcpHandlers(tool),
})
