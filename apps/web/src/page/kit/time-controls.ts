import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { icon } from "../../ui/icon"
import { refreshButton } from "../../ui/refresh-button"

// The time range header controls: the picker trigger, the reset for a custom range, and Reload.

/** The picker's preset rail (`PRESET_OPTIONS`); a page default must be one so the open picker marks it.
 * "24h" is rolling; "1d" would be today since midnight (`resolveRelativeRange` counts calendar days). */
export const PRESET_VALUES = ["5m", "15m", "30m", "1h", "6h", "12h", "24h", "3d", "1w", "2w", "1mo"] as const
export const LONG_RANGE_PRESET_VALUES = [...PRESET_VALUES, "3mo", "6mo", "12mo"] as const
export type PresetValue = (typeof LONG_RANGE_PRESET_VALUES)[number]

export const isPresetValue = (value: string): value is PresetValue =>
	LONG_RANGE_PRESET_VALUES.some((preset) => preset === value)

// `PRESET_OPTIONS` labels and `presetLabel`.
const PRESET_LABELS = new Map<string, string>([
	["5m", "Last 5 minutes"],
	["15m", "Last 15 minutes"],
	["30m", "Last 30 minutes"],
	["1h", "Last 1 hour"],
	["6h", "Last 6 hours"],
	["12h", "Last 12 hours"],
	["24h", "Last 24 hours"],
	["1d", "Last 1 day"],
	["3d", "Last 3 days"],
	["1w", "Last 1 week"],
	["2w", "Last 2 weeks"],
	["1mo", "Last 1 month"],
])

const UNIT_LABELS = new Map<string, readonly [string, string]>([
	["m", ["minute", "minutes"]],
	["h", ["hour", "hours"]],
	["d", ["day", "days"]],
	["w", ["week", "weeks"]],
	["mo", ["month", "months"]],
])

export const presetLabel = (shorthand: string): string => {
	if (shorthand === "12mo") return "Last 1 year"
	const known = PRESET_LABELS.get(shorthand)
	if (known !== undefined) return known
	const trimmed = shorthand.trim().toLowerCase()
	if (trimmed === "today") return "Today"
	const match = trimmed.match(/^(\d+)(mo|m|h|d|w)$/)
	if (match === null) return shorthand
	const amount = Number.parseInt(match[1] ?? "0", 10)
	const [singular, plural] = UNIT_LABELS.get(match[2] ?? "") ?? [match[2] ?? "", match[2] ?? ""]
	return `Last ${amount} ${amount === 1 ? singular : plural}`
}

export type TimeSearch = Readonly<{ startTime?: string; endTime?: string; timePreset?: string }>

/** `resolveSearchPreset`: the URL's own preset, else the default unless it pins an absolute range. */
export const searchPreset = (search: TimeSearch, defaultPreset: PresetValue): string | undefined =>
	search.timePreset ?? (search.startTime !== undefined ? undefined : defaultPreset)

export type TimeControlsOptions<M> = Readonly<{
	search: TimeSearch
	defaultPreset: PresetValue
	/** The effective window, shown for an absolute range. */
	window: Readonly<{ startTime: string; endTime: string }> | null
	/** The picker trigger, with the popover wiring the page passes (`page/kit/time-range-picker.ts`). */
	trigger: (label: string) => Html
	onReset: M
	onReload: M
	isReloading: boolean
	/** Replaces the plain Reload button (`reloadControls`: a `RefreshControls` with a cadence). */
	reloadControls?: Html
	/** Drops Reload while the page's failure card offers Try again, so there is one retry. */
	isReloadHidden?: boolean
}>

/** The header's time cluster. */
export const timeControls = <M>(h: HtmlBuilder<M>, options: TimeControlsOptions<M>): Html => {
	const preset = searchPreset(options.search, options.defaultPreset)
	const startTime = options.search.startTime ?? options.window?.startTime
	const endTime = options.search.endTime ?? options.window?.endTime
	const hasCustomRange = preset === undefined && startTime !== undefined
	// TODO(range-label): an absolute range should show `formatTimeRangeDisplay` (zone-aware).
	const label = preset !== undefined ? presetLabel(preset) : `${startTime ?? ""} - ${endTime ?? ""}`
	return h.div(
		[h.Class("flex flex-wrap items-center gap-2")],
		[
			h.div(
				[h.Class("flex items-center")],
				[
					options.trigger(label),
					...(hasCustomRange
						? [
								button(
									h,
									{
										variant: "outline",
										size: "sm",
										className: "-ml-px size-7 p-0",
										attributes: [
											h.AriaLabel("Reset to default time range"),
											h.OnClick(options.onReset),
										],
									},
									[icon(h, "XmarkIcon")],
								),
							]
						: []),
				],
			),
			...(options.isReloadHidden === true
				? []
				: [
						options.reloadControls ??
							refreshButton(h, {
								onRefresh: options.onReload,
								isPending: options.isReloading,
								label: "Reload",
							}),
					]),
		],
	)
}

/** The closed picker trigger (`TimeRangePicker`'s `PopoverTrigger` Button), clock and label. */
export const timeRangeTriggerContent = <M>(h: HtmlBuilder<M>, label: string): ReadonlyArray<Html> => [
	icon(h, "ClockIcon"),
	h.span([], [label]),
]
