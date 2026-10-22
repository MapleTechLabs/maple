import { CH } from "@maple/query-engine"
import type { TimeBounds } from "../../lib/time"
import type { DateTime } from "effect"
import { Effect } from "effect"
import { localParams, queryRows } from "../../data/local-query"
import type { SessionFacets, SessionRow } from "./model"

// The sessions list queries as Effects.

export const PAGE_SIZE = 50

export interface SessionFilters {
	readonly service?: string
	readonly browser?: string
	readonly device?: string
	readonly errorsOnly?: boolean
	readonly search?: string
}

export const filtersOf = (query: URLSearchParams): SessionFilters => ({
	service: query.get("service") || undefined,
	browser: query.get("browser") || undefined,
	device: query.get("device") || undefined,
	errorsOnly: query.get("errors") === "1",
	search: query.get("q") || undefined,
})

/** (StartTime, SessionId): start times are millisecond-resolution, so ties are ordinary. */
export interface SessionCursor {
	readonly startTime: DateTime.Utc
	readonly sessionId: string
}

const toRow = (row: CH.SessionReplaysListOutput): SessionRow => ({
	sessionId: row.sessionId,
	startTime: row.startTime,
	durationMs: row.durationMs,
	status: row.status,
	lastActivityAt: row.lastActivityAt,
	userId: row.userId,
	userName: row.userName,
	userEmail: row.userEmail,
	urlInitial: row.urlInitial,
	browserName: row.browserName,
	osName: row.osName,
	deviceType: row.deviceType,
	pageViews: row.pageViews,
	clickCount: row.clickCount,
	errorCount: row.errorCount,
	traceCount: row.traceCount,
})

export const fetchSessionPage = (
	filters: SessionFilters,
	bounds: TimeBounds,
	cursor: SessionCursor | undefined,
	apiBase: string,
) =>
	Effect.map(
		queryRows(
			CH.compile(
				CH.sessionReplaysListQuery({
					limit: PAGE_SIZE,
					cursor,
					serviceName: filters.service,
					browser: filters.browser,
					deviceType: filters.device,
					hasErrors: filters.errorsOnly,
					search: filters.search,
				}),
				localParams(bounds),
			),
			apiBase,
		),
		(rows) => rows.map(toRow),
	)

export const nextCursor = (page: ReadonlyArray<SessionRow>): SessionCursor | undefined => {
	const last = page.length === PAGE_SIZE ? page[page.length - 1] : undefined
	return last ? { startTime: last.startTime, sessionId: last.sessionId } : undefined
}

export const fetchSessionFacets = (filters: SessionFilters, bounds: TimeBounds, apiBase: string) =>
	Effect.map(
		queryRows(
			CH.compileUnion(
				CH.sessionReplaysFacetsQuery({
					serviceName: filters.service,
					browser: filters.browser,
					deviceType: filters.device,
					hasErrors: filters.errorsOnly,
					search: filters.search,
				}),
				localParams(bounds),
			),
			apiBase,
		),
		(rows): SessionFacets => {
			const pick = (facetType: string) =>
				rows
					.filter((row) => row.facetType === facetType && row.name)
					.map((row) => ({ name: row.name, count: row.count }))
			return {
				service: pick("service"),
				browser: pick("browser"),
				device: pick("device"),
				errorCount: rows.find((row) => row.facetType === "error")?.count ?? 0,
			}
		},
	)
