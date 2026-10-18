import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Resources } from "../../../platform/resources"
import { PageOutMessage } from "../../contract"
import { timeControls, type TimeSearch } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"

// The header time cluster every infra integration page shares: `DashboardPage`'s `time` prop.

export type TimePickerStep<M> = Readonly<{
	timePicker: TimeRangePicker.Model
	commands: ReadonlyArray<Command.Command<M, never, Resources>>
	outMessage?: PageOutMessage
}>

/** A picker Message: the popover's own state, and a picked preset as navigation to `hrefFor(preset)`. */
export const stepTimePicker = <M>(
	picker: TimeRangePicker.Model,
	message: TimeRangePicker.Message,
	toMessage: (message: TimeRangePicker.Message) => M,
	hrefFor: (preset: string) => string,
): TimePickerStep<M> => {
	const next = TimeRangePicker.update(picker, message)
	const commands = Command.mapMessages(next.commands, toMessage)
	return next.outMessage === undefined
		? { timePicker: next.model, commands }
		: {
				timePicker: next.model,
				commands,
				outMessage: PageOutMessage.RequestedNavigation({
					url: hrefFor(next.outMessage.presetValue),
					isReplace: false,
				}),
			}
}

/** `applyTimeRangeSearch` with a preset: the absolute bounds leave the URL. */
export const withPreset = <S extends TimeSearch>(search: S, preset: string): S => ({
	...search,
	startTime: undefined,
	endTime: undefined,
	timePreset: preset,
})

export type PageTimeOptions<M> = Readonly<{
	search: TimeSearch
	defaultPreset: string
	window: Readonly<{ startTime: string; endTime: string }> | null
	picker: TimeRangePicker.Model
	toPickerMessage: (message: TimeRangePicker.Message) => M
	onReset: M
	onReload: M
	isReloading: boolean
}>

export const pageTime = <M>(h: HtmlBuilder<M>, options: PageTimeOptions<M>): Html =>
	timeControls(h, {
		search: options.search,
		defaultPreset: options.defaultPreset,
		window: options.window,
		onReset: options.onReset,
		onReload: options.onReload,
		isReloading: options.isReloading,
		trigger: (label) =>
			h.submodel({
				slotId: "time-range-picker",
				model: options.picker,
				view: TimeRangePicker.view,
				toParentMessage: options.toPickerMessage,
				viewInputs: {
					label,
					selectedPreset:
						options.search.timePreset ??
						(options.search.startTime === undefined ? options.defaultPreset : undefined),
					presets: TimeRangePicker.PRESET_VALUES,
				},
			}),
	})
