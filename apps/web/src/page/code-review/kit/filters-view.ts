import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Select from "../../../ui/select"
import { type SelectEntry, type SelectOption, view as selectView } from "../../../ui/select-view"
import { timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { authorLabel } from "./author"
import { CI_MAX_RANGE_MS } from "./layout"
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
	defaultPreset: string
	presets: ReadonlyArray<string>
	toMessage: (message: FrameMessage) => M
}>

/** `CODE_REVIEW_CI_MAX_RANGE_SECONDS` on CI (the workflow filter), else `CODE_REVIEW_MAX_RANGE_SECONDS`. */
const maxRangeSecondsOf = (kind: FiltersOptions<unknown>["kind"]): number =>
	kind === "workflow" ? CI_MAX_RANGE_MS / 1000 : 365 * 24 * 60 * 60

const item = (value: string, label: string): SelectEntry => ({ _tag: "Item", item: { value, label } })

export const filtersView = <M>(h: HtmlBuilder<M>, options: FiltersOptions<M>): Html => {
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
	return h.div(
		[h.Class("flex flex-wrap items-center gap-2")],
		[
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
					className: "w-full min-w-0 @2xl/page:w-48",
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
					className: isAuthor ? "w-full min-w-0 @2xl/page:w-40" : "w-full min-w-0 @2xl/page:w-44",
					toView: (parts) => h.div([h.Class("contents")], parts),
					renderItem: (option: SelectOption) =>
						!isAuthor || option.value === ALL ? [option.label] : [authorLabel(h, option.value)],
				},
			}),
			timeControls(h, {
				search: options.search,
				defaultPreset: options.defaultPreset,
				window: frame.window,
				onReset: toMessage(FrameMessage.ClickedResetTimeRange()),
				onReload: toMessage(FrameMessage.ClickedReload()),
				isReloading: frame.isReloading,
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
							maxRangeSeconds: maxRangeSecondsOf(options.kind),
							startTime: frame.window?.startTime,
							endTime: frame.window?.endTime,
						},
					}),
			}),
		],
	)
}

/** CI keeps two weeks of raw traces: the presets stop there. */
export const CI_PRESETS = TimeRangePicker.PRESET_VALUES.filter((value) => value !== "1mo")
