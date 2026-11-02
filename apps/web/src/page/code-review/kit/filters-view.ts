import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Select from "../../../ui/select"
import { type SelectEntry, type SelectOption, view as selectView } from "../../../ui/select-view"
import { type PresetValue, timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { authorLabel } from "./author"
import { ALL, type Frame, FrameMessage, type WindowSearch } from "./frame"
import { repositoriesOf } from "./frame-update"

// `CodeReviewFilters` and `CodeReviewCiFilters`: repository, author or
// workflow, and the window.

export type FiltersOptions<M> = Readonly<{
	frame: Frame
	search: WindowSearch
	/** `RepositorySelect`'s `reviewedOnly`: Analytics, Pull requests and Issues; not CI. */
	reviewedOnly: boolean
	/** Authors or workflows; a value from the URL that is not listed leads the list. */
	kind: "author" | "workflow"
	options: ReadonlyArray<string>
	selected: string | undefined
	defaultPreset: PresetValue
	presets: ReadonlyArray<string>
	toMessage: (message: FrameMessage) => M
	/** True while the tab's failure card shows, so its Try again is the only retry. */
	isFailed?: boolean
}>

/** `CODE_REVIEW_MAX_RANGE_SECONDS`: a year, which the CI tab's `ci_runs` keeps too. */
const MAX_RANGE_SECONDS = 365 * 24 * 60 * 60

const item = (value: string, label: string): SelectEntry => ({ _tag: "Item", item: { value, label } })

/** The header keeps the window and reload; repository and author or workflow join the tab's filter row. */
export type CodeReviewFilters = Readonly<{ actions: Html; filters: ReadonlyArray<Html> }>

export const filtersView = <M>(h: HtmlBuilder<M>, options: FiltersOptions<M>): CodeReviewFilters => {
	const { frame, toMessage } = options
	const repositories = repositoriesOf(frame, options.reviewedOnly)
	const repoEntries = [
		item(ALL, "All repositories"),
		...repositories.map((repo) => item(repo.id, repo.fullName)),
	]
	const listed =
		options.selected !== undefined && !options.options.includes(options.selected)
			? [options.selected, ...options.options]
			: options.options
	const isAuthor = options.kind === "author"
	const optionEntries = [
		item(ALL, isAuthor ? "All authors" : "All workflows"),
		...listed.map((value) => item(value, value)),
	]
	const preset =
		options.search.timePreset ??
		(options.search.startTime === undefined ? options.defaultPreset : undefined)
	return {
		filters: [
			h.submodel({
				slotId: frame.repoSelect.id,
				model: frame.repoSelect,
				view: selectView,
				toParentMessage: (message: Select.Message) =>
					toMessage(FrameMessage.GotRepoSelectMessage({ message })),
				viewInputs: {
					entries: repoEntries,
					size: "sm",
					ariaLabel: "Repository",
					className: "w-48 min-w-0",
					toView: (parts) => h.div([h.Class("contents")], parts),
				},
			}),
			h.submodel({
				slotId: frame.optionSelect.id,
				model: frame.optionSelect,
				view: selectView,
				toParentMessage: (message: Select.Message) =>
					toMessage(FrameMessage.GotOptionSelectMessage({ message })),
				viewInputs: {
					entries: optionEntries,
					size: "sm",
					ariaLabel: isAuthor ? "Author" : "Workflow",
					// One width on every tab, so switching between authors and workflows moves nothing.
					className: "w-48 min-w-0",
					toView: (parts) => h.div([h.Class("contents")], parts),
					renderItem: (option: SelectOption) =>
						!isAuthor || option.value === ALL ? [option.label] : [authorLabel(h, option.value)],
				},
			}),
		],
		actions: timeControls(h, {
			search: options.search,
			defaultPreset: options.defaultPreset,
			window: frame.window,
			onReset: toMessage(FrameMessage.ClickedResetTimeRange()),
			onReload: toMessage(FrameMessage.ClickedReload()),
			isReloading: frame.isReloading,
			isReloadHidden: options.isFailed,
			trigger: (label) =>
				h.submodel({
					slotId: frame.timePicker.popover.id,
					model: frame.timePicker,
					view: TimeRangePicker.view,
					toParentMessage: (message: TimeRangePicker.Message) =>
						toMessage(FrameMessage.GotTimePickerMessage({ message })),
					viewInputs: {
						label,
						selectedPreset: preset,
						presets: options.presets,
						maxRangeSeconds: MAX_RANGE_SECONDS,
						startTime: frame.window?.startTime,
						endTime: frame.window?.endTime,
					},
				}),
		}),
	}
}
