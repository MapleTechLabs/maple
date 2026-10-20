import type { Html, HtmlBuilder } from "foldkit/html"
import * as SelectView from "../../ui/select-view"
import { FILTER_MODES } from "./gcp-configure-copy"
import type { ConfigureModel } from "./gcp-configure-schema"
import { Message } from "./message"

// The `Select` of `GcpLogFilterField`: keep an existing sink's filter, or replace it.

type H = HtmlBuilder<Message>

const ENTRIES: ReadonlyArray<SelectView.SelectEntry> = FILTER_MODES.map((mode) => ({
	_tag: "Item",
	item: { value: mode.value, label: mode.label },
}))

/** `FilterMode`: the mode by name, with what it does beside it. */
const filterMode = (h: H, value: string): ReadonlyArray<Html> => {
	const mode = FILTER_MODES.find((entry) => entry.value === value)
	if (mode === undefined) return []
	return [
		h.span(
			[h.Class("flex min-w-0 items-baseline gap-2.5")],
			[
				h.span([h.Class("shrink-0 font-medium")], [mode.label]),
				h.span([h.Class("truncate text-xs text-muted-foreground")], [mode.hint]),
			],
		),
	]
}

/** Slotted by the Select's id, so several fields can share a page (the lab). */
export const filterModeSelect = (
	h: H,
	configure: Pick<ConfigureModel, "filterMode">,
	keep: boolean,
	labelledBy?: string,
): ReadonlyArray<Html> => [
	h.submodel({
		slotId: configure.filterMode.id,
		model: { ...configure.filterMode, value: keep ? "keep" : "set" },
		view: SelectView.view,
		viewInputs: {
			entries: ENTRIES,
			labelledBy,
			className: "w-full",
			renderValue: (value) => filterMode(h, value),
			renderItem: (option) => filterMode(h, option.value),
			toView: (parts) => h.div([h.Class("contents")], parts),
		},
		toParentMessage: (message) => Message.GotGcpFilterModeMessage({ message }),
	}),
]
