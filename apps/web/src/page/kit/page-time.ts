import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Resources } from "../../platform/resources"
import { PageOutMessage, type PageReturn } from "../contract"
import { type PresetValue, timeControls, type TimeSearch } from "./time-controls"
import * as TimeRangePicker from "./time-range-picker"

// The header time cluster pages share, and the picker's update step.

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
	/** The page URL for a picked range (`withPreset` takes it). */
	hrefFor: (picked: TimeRangePicker.TimeSearchPatch) => string,
): TimePickerStep<M> => {
	const next = TimeRangePicker.update(picker, message)
	const commands = Command.mapMessages(next.commands, toMessage)
	return next.outMessage === undefined || next.outMessage._tag === "RejectedRange"
		? { timePicker: next.model, commands }
		: {
				timePicker: next.model,
				commands,
				outMessage: PageOutMessage.RequestedNavigation({
					url: hrefFor(TimeRangePicker.searchPatchOf(next.outMessage)),
					isReplace: false,
				}),
			}
}

/**
 * A page's `GotTimePickerMessage`: the picker's next state in the Model, and a picked range as
 * `onPick(patch)`'s OutMessage. `toastRejected`: a range wider than allowed shows its toast.
 */
export const pickerStep = <Model extends Readonly<{ timePicker: TimeRangePicker.Model }>, M>(
	model: Model,
	message: TimeRangePicker.Message,
	toMessage: (message: TimeRangePicker.Message) => M,
	onPick: (patch: TimeRangePicker.TimeSearchPatch) => PageOutMessage | undefined,
	options?: Readonly<{ toastRejected?: boolean }>,
): PageReturn<Model, M> => {
	const next = TimeRangePicker.update(model.timePicker, message)
	const lifted = {
		model: { ...model, timePicker: next.model },
		commands: Command.mapMessages(next.commands, toMessage),
	}
	if (next.outMessage === undefined || next.outMessage._tag === "RejectedRange")
		return options?.toastRejected === true ? TimeRangePicker.unpicked(lifted, next.outMessage) : lifted
	return { ...lifted, outMessage: onPick(TimeRangePicker.searchPatchOf(next.outMessage)) }
}

/** A preset clears the absolute bounds, a custom range the preset. */
export const withPreset = <S extends TimeSearch>(
	search: S,
	picked: string | TimeRangePicker.TimeSearchPatch,
): S => ({
	...search,
	...(typeof picked === "string"
		? { startTime: undefined, endTime: undefined, timePreset: picked }
		: picked),
})

export type PageTimeOptions<M> = Readonly<{
	search: TimeSearch
	defaultPreset: PresetValue
	window: Readonly<{ startTime: string; endTime: string }> | null
	picker: TimeRangePicker.Model
	/** The picker's preset rail, when the page's is not the standard one; holds `defaultPreset`. */
	presets?: ReadonlyArray<string>
	toPickerMessage: (message: TimeRangePicker.Message) => M
	onReset: M
	onReload: M
	isReloading: boolean
	/** True while the page's failure card shows, so its Try again is the only retry. */
	isReloadHidden?: boolean
}>

export const pageTime = <M>(h: HtmlBuilder<M>, options: PageTimeOptions<M>): Html =>
	timeControls(h, {
		search: options.search,
		defaultPreset: options.defaultPreset,
		window: options.window,
		onReset: options.onReset,
		onReload: options.onReload,
		isReloading: options.isReloading,
		isReloadHidden: options.isReloadHidden,
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
					presets: options.presets ?? TimeRangePicker.PRESET_VALUES,
				},
			}),
	})
