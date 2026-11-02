import type { SpanId, TraceId } from "@maple/domain"
import { AppRoute, hrefOf } from "../../route"

// Where the logs pages link: one log's page and a log's trace.

/** `/logs/$logId` for a log key. */
export const logPageHref = (logKey: string): string => hrefOf(AppRoute.Log({ logId: logKey }))

/** The log sheet's `logPagePath`: the log page's path before its key. */
export const LOG_PAGE_PATH = logPageHref("")

/** The trace page at the log's instant (the page selects no span from a log). */
export const logTraceHref = (traceId: TraceId, _spanId: SpanId | undefined, timestamp: string): string =>
	hrefOf(AppRoute.Trace({ traceId, search: { t: timestamp } }))
