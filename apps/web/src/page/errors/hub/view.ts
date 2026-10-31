import { pluralize } from "@maple/ui/lib/format"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { activeFilterChips } from "../../../ui/filters/active-filter-chips"
import { isMounted } from "../../../ui/overlay/transition"
import { refreshButton } from "../../../ui/refresh-button"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { stableSlice } from "../../kit/stable-slice"
import { errorFilterChips, listStatusOf, pagingOf, signalsOf, sparkWindowOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { filtersRail } from "./view-filters"
import { isNarrowedBySidebar } from "./view-empty"
import { listBody } from "./view-list"
import { statStrip, toolbar } from "./view-toolbar"

// The errors page: sidebar, Reload, chips and the hub.

type H = HtmlBuilder<Message>

/** No count until there is one to state; a paged list says "50+" rather than a total. */
const countReadout = (model: Model, shown: number): ReadonlyArray<string> | null => {
	if (listStatusOf(model) !== "ready") return null
	if (pagingOf(model) !== "end") return [`${shown}+ issues`]
	// Split where the JSX interpolates, so the text runs match.
	return [String(shown), " ", pluralize(shown, "issue")]
}

/** Kept by reference across renders, so the memoized rows that read it stay cached. */
const stableSparkWindow = stableSlice((window: Model["window"]) =>
	window === null ? { startMs: 0, endMs: 0, bucketMs: 0 } : sparkWindowOf(window),
)

const hub = (h: H, model: Model, inputs: PageViewInputs): Html => {
	const signals = signalsOf(model)
	const status = listStatusOf(model)
	const sparkWindow = stableSparkWindow(model.window)
	const isSelecting = model.selectedIds.length > 0
	const strip = statStrip(h, model)
	return h.div(
		[],
		[
			...(strip === null ? [] : [strip]),
			toolbar(h, model, countReadout(model, signals.length)),
			...listBody(h, model, {
				status,
				signals,
				isNarrowed: isNarrowedBySidebar(model),
				rowState: (signal) => ({
					isSelected: model.selectedIds.includes(signal.id),
					isSelecting,
					isFocused: model.focusedId === signal.id,
					timeZone: inputs.context.timeZone,
					nowMs: model.nowMs,
					sparkWindow,
					picker: model.picker !== null && model.picker.issueId === signal.id ? model.picker : null,
					// Only a showing menu swaps the row for its trigger: a press alone must keep the row's
					// DOM (and the focused checkbox in it).
					rowMenu:
						model.rowMenuTarget === signal.id &&
						isMounted(model.rowMenu.isOpen, model.rowMenu.animation)
							? model.rowMenu
							: null,
				}),
			}),
		],
	)
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	dashboardPage(
		h,
		{
			title: "Errors",
			filters: filtersRail(h, model),
			// The toolbar sits one header gap under the title, as tabs do on tabbed pages.
			scrollClassName: "pt-0",
			actions: refreshButton(h, {
				onRefresh: Message.ClickedReload(),
				isPending: model.isReloading,
				label: "Reload",
				// The failure card's Try again is the one retry while the list is failed.
				isHidden: listStatusOf(model) === "failed",
			}),
		},
		[
			activeFilterChips(h, {
				chips: errorFilterChips(model.search).map((chip) => ({
					id: chip.param,
					label: chip.label,
					values: chip.values,
					onRemove: Message.RemovedFilterChip({ param: chip.param }),
				})),
				onClearAll: Message.ClickedClearFilters(),
			}),
			hub(h, model, inputs),
		].filter((node): node is Html => node !== null),
	),
)
