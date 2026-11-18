import { logTimeFormat, toLogRowView, type LogRowLinks } from "@maple/views/ui/logs/log-row-view"
import * as LogsStream from "@maple/views/ui/logs/logs-stream"
import * as LogsStreamView from "@maple/views/ui/logs/logs-stream-view"
import { COMPACT_ROW_HEIGHT } from "@maple/views/ui/logs/log-row"
import { Array as Arr, Option, Schema } from "effect"
import { makeIsland } from "../../foldkit-island/island"
import { LOGS_STREAM_ROWS } from "./live-logs-stream-data"

/**
 * The /logs stream itself (the dashboard's `LogsStream` Submodel) over example rows: a click expands
 * a row, chips open their attribute card. Times read in UTC so the server and
 * the browser render the same text.
 */

const TIME_ZONE = "UTC"

/** The landing has no trace or log pages to link a row to. */
const NO_LINKS: LogRowLinks = { trace: () => "", log: Option.none() }

const rows = Arr.map(LOGS_STREAM_ROWS, (log) => toLogRowView(log, [], logTimeFormat(TIME_ZONE), NO_LINKS))

/**
 * The stream's own update, except that the landing has no detail sheet: opening a row expands it,
 * and an expanded row's Details button, which would only fold the row it sits in, does nothing.
 */
export const update = (model: LogsStream.Model, message: LogsStream.Message) => {
	const next = LogsStream.update(model, message)
	if (next.outMessage?._tag !== "OpenedLog" || message._tag === "ClickedDetails")
		return { model: next.model, commands: next.commands }
	const expanded = LogsStream.update(
		next.model,
		LogsStream.Message.ClickedExpand({ index: next.outMessage.index }),
	)
	return { model: expanded.model, commands: [...(next.commands ?? []), ...(expanded.commands ?? [])] }
}

export const LiveLogsStream = makeIsland({
	name: "LiveLogsStream",
	Props: Schema.Struct({}),
	Model: LogsStream.Model,
	init: () => ({
		model: {
			...LogsStream.init("landing-logs", rows),
			window: Arr.map(rows, (_, index) => ({ index, start: index * COMPACT_ROW_HEIGHT })),
			totalSize: rows.length * COMPACT_ROW_HEIGHT,
		},
	}),
	update,
	view: (model, h) =>
		LogsStreamView.view(
			model,
			{
				wrap: false,
				density: "compact",
				pinnedColumns: [],
				searchText: undefined,
				timeZone: TIME_ZONE,
				isWaiting: false,
				footerText: `${rows.length} logs`,
				canFilter: false,
			},
			h,
		) ?? h.empty,
})
