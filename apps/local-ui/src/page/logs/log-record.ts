import {
	type LogRowLinks,
	type LogRowView,
	logTimeFormat,
	toLogRowView,
} from "@maple/views/ui/logs/log-row-view"
import { Option, Array as Arr } from "effect"
import { toLogRecord } from "../../lib/log-shape"
import { hrefFor } from "../../route"
import type { LocalLog } from "./model"

// Maple Local's log as the shared logs stream reads it.

/** A trace opens in Local's trace page; Local has no page for a single log, so no permalink. */
export const LOCAL_LOG_LINKS: LogRowLinks = {
	trace: (traceId) => hrefFor(`/traces/${encodeURIComponent(traceId)}`),
	log: Option.none(),
}

export const toStreamRows = (
	logs: ReadonlyArray<LocalLog>,
	columns: ReadonlyArray<string>,
	timeZone: string,
): ReadonlyArray<LogRowView> => {
	const time = logTimeFormat(timeZone)
	return Arr.map(logs, (log) => toLogRowView(toLogRecord(log), columns, time, LOCAL_LOG_LINKS))
}
