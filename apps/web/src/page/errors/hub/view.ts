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

/** The stat strip and toolbar, pinned under the title like the other list pages' toolbars. */
const pinnedToolbar = (h: H, model: Model): Html => {
	const strip = statStrip(h, model)
	// The sticky area pads the page edge, so the toolbar adds no gap under itself.
	const bar = toolbar(h, model, countReadout(model, signalsOf(model).length), "pb-0")
	return strip === null ? bar : h.div([], [strip, bar])
}

const hub = (h: H, model: Model, inputs: PageViewInputs): Html => {
	const signals = signalsOf(model)
	const status = listStatusOf(model)
	const sparkWindow = stableSparkWindow(model.window)
	const isSelecting = model.selectedIds.length > 0
	return h.div(
		[],
		[
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
			sticky: pinnedToolbar(h, model),
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
