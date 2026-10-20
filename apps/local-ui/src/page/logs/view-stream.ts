import type { TimeFormat } from "../kit/local-time"
import { cn } from "@maple/ui/lib/utils"
import { spinner } from "@maple/web/ui/spinner"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "./message"
import type { Model } from "./model"
import { logKey, rowsOf } from "./stream"
import { logRow } from "./view-row"
import { ObserveLogsViewport, ROW_HEIGHT, virtualWindow } from "./virtualize"

/** `LogListMode`'s virtualized stream: only the rows in (or near) the scroller's view are built. */
export const logStream = (h: HtmlBuilder<Message>, model: Model, search: string | undefined, timeFormat: TimeFormat): Html => {
	const rows = rowsOf(model)
	const selectedKey = Option.match(model.maybeDetail, { onNone: () => null, onSome: (detail) => logKey(detail.log) })
	return h.div(
		[
			h.Role("list"),
			h.AriaLabel("Logs"),
			h.Class(cn("h-full overflow-auto", model.logs.isPlaceholder && "opacity-60 transition-opacity")),
			h.OnMount(ObserveLogsViewport()),
		],
		[
			h.div(
				[h.Style({ height: `${rows.length * ROW_HEIGHT}px`, position: "relative" })],
				virtualWindow(rows.length, model.viewport).flatMap((index) => {
					const log = rows[index]
					return log === undefined
						? []
						: [
								logRow(h, {
									log,
									index,
									search,
									top: index * ROW_HEIGHT,
									isSelected: selectedKey === logKey(log),
									nowMs: model.nowMs,
									timeFormat,
								}),
							]
				}),
			),
			...(model.isFetchingNextPage ? [h.div([h.Class("flex justify-center p-3")], [spinner(h, "size-4")])] : []),
		],
	)
}
