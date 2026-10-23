import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { errorState } from "../../../ui/error-state"
import { listFooter } from "../../../ui/list-footer"
import type * as Select from "../../../ui/select"
import { type SelectEntry, view as selectView } from "../../../ui/select-view"
import { skeletonList } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { filtersView } from "../kit/filters-view"
import { nothingInWindow } from "../../kit/nothing-in-window"
import { codeReviewLayout } from "../kit/layout"
import type { SheetMessage } from "../kit/review-sheet"
import * as ReviewSheetView from "../kit/review-sheet-view"
import { Message, type Model } from "./model"
import { DEFAULT_PRESET, MAX_ROWS, STATUS_LABELS } from "./update"
import { reviewTable } from "./view-table"

// The code review pull requests page.

type H = HtmlBuilder<Message>

const STATUS_ENTRIES: ReadonlyArray<SelectEntry> = Object.entries(STATUS_LABELS).map(([value, label]) => ({
	_tag: "Item",
	item: { value, label },
}))

const isFiltered = (model: Model) =>
	model.search.repo !== undefined || model.search.author !== undefined || model.search.status !== undefined

const content = (h: H, model: Model, timeZone: string): Html =>
	AsyncData.matchData(model.reviews.data, {
		onEmpty: () => skeletonList(h, { rows: 6, rowClassName: "h-14", gap: "2" }),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Failed to load reviews",
				onRetry: Message.ClickedRetry(),
			}),
		onData: (response) => {
			if (response.reviews.length === 0) {
				const filtered = isFiltered(model)
				return nothingInWindow(h, {
					title: "No reviews in this window",
					description: filtered
						? "Nothing matches these filters."
						: "Reviews appear here once a pull request is opened on a reviewed repository.",
					onClear: filtered ? Message.ClickedClearFilters() : undefined,
				})
			}
			const footer =
				response.nextCursor === null
					? null
					: listFooter(h, {
							shown: response.reviews.length,
							noun: "reviews",
							hasMore: model.limit < MAX_ROWS,
							isCapped: model.limit >= MAX_ROWS,
							isLoading: AsyncData.isRefreshing(model.reviews.data),
							onLoadMore: Message.ClickedLoadMore(),
						})
			return h.div(
				[h.Class("flex flex-col gap-3")],
				[
					reviewTable(h, response.reviews, {
						selected: model.search.review,
						nowMs: model.frame.nowMs,
						timeZone,
					}),
					...(footer === null ? [] : [footer]),
				],
			)
		},
	})

const statusSelect = (h: H, model: Model): Html =>
	h.div(
		[h.Class("flex items-center justify-between gap-3")],
		[
			h.submodel({
				slotId: model.statusSelect.id,
				model: model.statusSelect,
				view: selectView,
				toParentMessage: (message: Select.Message) => Message.GotStatusSelectMessage({ message }),
				viewInputs: {
					entries: STATUS_ENTRIES,
					size: "sm",
					ariaLabel: "Status",
					className: "w-40",
					toView: (parts) => h.div([h.Class("contents")], parts),
				},
			}),
		],
	)

const authorsOf = (model: Model): ReadonlyArray<string> =>
	Option.match(AsyncData.getData(model.authors.data), {
		onNone: () => [],
		onSome: (analytics) => analytics.authors.map((row) => row.author),
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	codeReviewLayout(
		{
			h,
			active: "pull-requests",
			search: model.search,
			nowMs: model.frame.nowMs,
			timeZone: inputs.context.timeZone,
			toolbar: filtersView(h, {
				frame: model.frame,
				search: model.search,
				reviewedOnly: true,
				kind: "author",
				options: authorsOf(model),
				selected: model.search.author,
				defaultPreset: DEFAULT_PRESET,
				presets: TimeRangePicker.LONG_RANGE_PRESET_VALUES,
				toMessage: (message) => Message.GotFrameMessage({ message }),
			}),
			overlay: h.submodel({
				slotId: "code-review-pull-requests-sheet",
				model: model.sheet,
				view: ReviewSheetView.view,
				viewInputs: { timeZone: inputs.context.timeZone },
				toParentMessage: (message: SheetMessage) => Message.GotSheetMessage({ message }),
			}),
		},
		[statusSelect(h, model), content(h, model, inputs.context.timeZone)],
	),
)
