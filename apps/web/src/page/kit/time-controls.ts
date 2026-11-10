import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import { refreshButton } from "@maple/views/ui/refresh-button"
import { presetLabel } from "@maple/ui/lib/time-preset"
import { Array as Arr } from "effect"

// The time range header controls: the picker trigger, the reset for a custom range, and Reload.

/** The picker's preset rail; a page default must be one so the open picker marks it. "24h" is
 * rolling; "1d" would be today since midnight (relative ranges count calendar days). */
export const PRESET_VALUES = ["5m", "15m", "30m", "1h", "6h", "12h", "24h", "3d", "1w", "2w", "1mo"] as const
export const LONG_RANGE_PRESET_VALUES = [...PRESET_VALUES, "3mo", "6mo", "12mo"] as const
export type PresetValue = (typeof LONG_RANGE_PRESET_VALUES)[number]

export const isPresetValue = (value: string): value is PresetValue =>
	Arr.some(LONG_RANGE_PRESET_VALUES, (preset) => preset === value)

export type TimeSearch = Readonly<{ startTime?: string; endTime?: string; timePreset?: string }>

/** The URL's own preset, else the default unless it pins an absolute range. */
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
	/** Replaces the plain Reload button (a refresh control with a cadence). */
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
	// TODO(range-label): an absolute range should show a zone-aware label, not the raw bounds.
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

/** The closed picker trigger's content: clock and label. */
export const timeRangeTriggerContent = <M>(h: HtmlBuilder<M>, label: string): ReadonlyArray<Html> => [
	icon(h, "ClockIcon"),
	h.span([], [label]),
]

// The preset an empty page offers to widen to.
export const WIDEN_TIME_PRESET = "7d"
const WIDE_TIME_PRESETS = new Set([
	"7d",
	"1w",
	"10d",
	"14d",
	"2w",
	"30d",
	"6w",
	"1mo",
	"2mo",
	"3mo",
	"6mo",
	"12mo",
])

/** Widening only helps from a short relative preset. */
export const canWidenTimeRange = (search: TimeSearch, defaultPreset: string): boolean =>
	search.startTime === undefined && !WIDE_TIME_PRESETS.has(search.timePreset ?? defaultPreset)
