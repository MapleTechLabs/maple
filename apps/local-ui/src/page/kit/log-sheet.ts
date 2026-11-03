import type { SpanId, TraceId } from "@maple/domain"
import { LOCAL_ORG_ID } from "@maple/query-engine/local"
import * as LogSheet from "@maple/views/logs/log-sheet"
import { Option } from "effect"
import { type LocalLog, toLogRecord } from "../../lib/log-shape"
import { hrefFor } from "../../route"
import type { TimeFormat } from "./local-time"

// The shared log sheet as Maple Local opens it: no namespace pin, no page for one log, no
// Infrastructure tab.

const LOCAL_SCOPE: LogSheet.Scope = { orgId: LOCAL_ORG_ID, pinnedNamespace: null }

/** The sheet showing `log`, opening it (a closed sheet keeps its place until then). */
export const openLocalLog = (maybeSheet: Option.Option<LogSheet.Model>, id: string, log: LocalLog): LogSheet.Return =>
	LogSheet.open(
		Option.getOrElse(maybeSheet, () => LogSheet.init(id)),
		toLogRecord(log),
		LOCAL_SCOPE,
	)

/** The trace page with the log's span selected. */
export const traceHash = (traceId: TraceId, spanId: SpanId | undefined): string =>
	hrefFor(`/traces/${encodeURIComponent(traceId)}`, new URLSearchParams(spanId === undefined ? {} : { spanId }))

/** The sheet's clock: the reader's zone on Local's 24h clock, as its rows read. */
export const sheetClock = (format: TimeFormat) => ({ timeZone: format.timeZone, hourCycle: "h23" as const })
