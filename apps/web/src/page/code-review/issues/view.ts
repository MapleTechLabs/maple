import { PrReviewCategory, PrReviewFindingStatus, PrReviewSeverity } from "@maple/domain/http"
import {
	CATEGORY_LABELS,
	FINDING_STATUS_LABELS,
	SEVERITY_LABELS,
} from "../../../components/code-review/code-review-format"
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
import { ALL } from "../kit/frame"
import { filtersView } from "../kit/filters-view"
import { codeReviewLayout, nothingInWindow } from "../kit/layout"
import type { SheetMessage } from "../kit/review-sheet"
import * as ReviewSheetView from "../kit/review-sheet-view"
import { type FilterKey, Message, type Model } from "./model"
import { DEFAULT_PRESET, MAX_ROWS } from "./update"
import { findingsList } from "./view-list"

// The code review issues page.

type H = HtmlBuilder<Message>

const entries = (
	allLabel: string,
	options: ReadonlyArray<readonly [string, string]>,
): ReadonlyArray<SelectEntry> => [
	{ _tag: "Item", item: { value: ALL, label: allLabel } },
	...options.map(([value, label]): SelectEntry => ({ _tag: "Item", item: { value, label } })),
]

const FILTERS: ReadonlyArray<{
	filter: FilterKey
	label: string
	field: "severitySelect" | "categorySelect" | "stateSelect"
	entries: ReadonlyArray<SelectEntry>
}> = [
	{
		filter: "severity",
		label: "Severity",
		field: "severitySelect",
		entries: entries(
			"All severities",
			PrReviewSeverity.literals.map((value) => [value, SEVERITY_LABELS[value]]),
		),
	},
	{
		filter: "category",
		label: "Category",
		field: "categorySelect",
		entries: entries(
			"All categories",
			PrReviewCategory.literals.map((value) => [value, CATEGORY_LABELS[value]]),
		),
	},
	{
		filter: "state",
		label: "State",
		field: "stateSelect",
		entries: entries(
			"Any state",
			PrReviewFindingStatus.literals.map((value) => [value, FINDING_STATUS_LABELS[value]]),
		),
	},
]

const filterSelects = (h: H, model: Model): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-2")],
		FILTERS.map(({ filter, label, field, entries: options }) =>
			h.submodel({
				slotId: model[field].id,
				model: model[field],
				view: selectView,
				toParentMessage: (message: Select.Message) =>
					Message.GotFilterSelectMessage({ filter, message }),
				viewInputs: {
					entries: options,
					size: "sm",
					ariaLabel: label,
					className: "w-40",
					toView: (parts) => h.div([h.Class("contents")], parts),
				},
			}),
		),
	)

const isFiltered = (model: Model) =>
	model.search.repo !== undefined ||
	model.search.author !== undefined ||
	model.search.severity !== undefined ||
	model.search.category !== undefined ||
	model.search.state !== undefined

const content = (h: H, model: Model, timeZone: string): Html =>
	AsyncData.matchData(model.findings.data, {
		onEmpty: () => skeletonList(h, { rows: 6, rowClassName: "h-16", gap: "2" }),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Failed to load issues",
				onRetry: Message.ClickedRetry(),
			}),
		onData: (response) => {
			if (response.findings.length === 0) {
				const filtered = isFiltered(model)
				return nothingInWindow(h, {
					title: "No issues in this window",
					description: filtered
						? "Nothing matches these filters."
						: "Issues the reviewer posts on pull requests are listed here.",
					onClear: filtered ? Message.ClickedClearFilters() : undefined,
				})
			}
			const footer =
				response.nextCursor === null
					? null
					: listFooter(h, {
							shown: response.findings.length,
							noun: "issues",
							hasMore: model.limit < MAX_ROWS,
							isCapped: model.limit >= MAX_ROWS,
							isLoading: AsyncData.isRefreshing(model.findings.data),
							onLoadMore: Message.ClickedLoadMore(),
						})
			return h.div(
				[h.Class("flex flex-col gap-3")],
				[findingsList(h, model, response.findings, timeZone), ...(footer === null ? [] : [footer])],
			)
		},
	})

const authorsOf = (model: Model): ReadonlyArray<string> =>
	Option.match(AsyncData.getData(model.authors.data), {
		onNone: () => [],
		onSome: (analytics) => analytics.authors.map((row) => row.author),
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	codeReviewLayout(
		{
			h,
			active: "issues",
			search: model.search,
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
				slotId: "code-review-issues-sheet",
				model: model.sheet,
				view: ReviewSheetView.view,
				viewInputs: { timeZone: inputs.context.timeZone },
				toParentMessage: (message: SheetMessage) => Message.GotSheetMessage({ message }),
			}),
		},
		[filterSelects(h, model), content(h, model, inputs.context.timeZone)],
	),
)
