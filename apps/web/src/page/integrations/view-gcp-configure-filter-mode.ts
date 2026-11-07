import type { Html, HtmlBuilder } from "foldkit/html"
import * as SelectView from "@maple/views/ui/select-view"
import { FILTER_MODES } from "./gcp-configure-copy"
import type { ConfigureModel } from "./gcp-configure-schema"
import { Message } from "./message"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr, Option } from "effect"
import { hstack } from "@maple/views/ui/stack"

// The `Select` of `GcpLogFilterField`: keep an existing sink's filter, or replace it.

type H = HtmlBuilder<Message>

const ENTRIES: ReadonlyArray<SelectView.SelectEntry> = Arr.map(FILTER_MODES, (mode) => ({
	_tag: "Item",
	item: { value: mode.value, label: mode.label },
}))

/** `FilterMode`: the mode by name, with what it does beside it. */
const filterMode = (h: H, value: string): ReadonlyArray<Html> => {
	const found = Arr.findFirst(FILTER_MODES, (entry) => entry.value === value)
	if (Option.isNone(found)) return []
	const mode = found.value
	return [
		hstack(h, { gap: "2.5", align: "baseline", shrink: true, as: "span" }, [
			typography(h, { weight: "medium", className: "shrink-0" }, [mode.label]),
			typography(h, { size: "xs", tone: "muted", truncate: true }, [mode.hint]),
		]),
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
