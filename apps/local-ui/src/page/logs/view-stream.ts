import { encodeLogAttributeFilter } from "@maple/views/lib/log-attribute-filters"
import { activeFilterChips } from "@maple/views/ui/filters/active-filter-chips"
import * as LogsStreamView from "@maple/views/ui/logs/logs-stream-view"
import { listFooterText } from "@maple/views/ui/logs/viewer"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { TimeFormat } from "../kit/local-time"
import { logKey } from "../../lib/log-shape"
import { attributeFiltersOf, type LogFilters } from "./filters"
import { Message } from "./message"
import type { Model } from "./model"
import { rowsOf } from "./update-stream"

// The list mode's stream (the shared logs stream) and the attribute filters it adds.

/** The applied attribute filters, each removable; nothing when none is set. */
export const attributeFilterChips = (h: HtmlBuilder<Message>, filters: LogFilters): ReadonlyArray<Html> => {
	const chips = activeFilterChips(h, {
		chips: attributeFiltersOf(filters).map((filter) => {
			const entry = encodeLogAttributeFilter(filter)
			return {
				id: entry,
				label: filter.key,
				values: [filter.value],
				isNegated: filter.negated,
				onRemove: Message.RemovedAttributeFilter(filter),
			}
		}),
		className: "mb-0 border-b px-4 py-2",
	})
	return chips === null ? [] : [chips]
}

/** The row the sheet shows (open or closed), so it stays marked. */
const selectedIndexOf = (model: Model): number | undefined =>
	Option.match(model.maybeDetail, {
		onNone: () => undefined,
		onSome: (detail) => {
			const index = rowsOf(model).findIndex((log) => logKey(log) === logKey(detail.log))
			return index === -1 ? undefined : index
		},
	})

export const logStream = (
	h: HtmlBuilder<Message>,
	model: Model,
	search: string | undefined,
	timeFormat: TimeFormat,
): Html =>
	h.div(
		[h.Class("flex h-full min-h-0 flex-col p-3")],
		[
			h.submodel({
				slotId: "local-logs-stream",
				model: model.stream,
				view: LogsStreamView.view,
				toParentMessage: (message) => Message.GotStreamMessage({ message }),
				viewInputs: {
					wrap: model.wrap,
					density: model.density,
					pinnedColumns: model.columns,
					searchText: search,
					timeZone: timeFormat.timeZone,
					isWaiting: model.logs.retained === true,
					footerText: listFooterText(timeFormat.locale, {
						shown: model.stream.rows.length,
						noun: "logs",
						capped: false,
						hasMore: Option.exists(AsyncData.getData(model.logs.data), (data) => data.hasNextPage),
					}),
					canFilter: true,
					selectedIndex: selectedIndexOf(model),
				},
			}),
		],
	)
