import { reloadSpin } from "@maple/views/data/timing"
import { RequestMode } from "@maple/views/data/keyed"
import { Clock, Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { CallableTaggedStruct } from "foldkit/schema"
import { resolveWindow, TimeWindow } from "../../data/time-range"
import { type PresetValue, timeControls, type TimeSearch } from "./time-controls"
import { INITIAL_LOCALE, readLocale } from "@maple/views/lib/locale"
import * as TimeRangePicker from "./time-range-picker"

// A page's time scope (the infra pages embed it whole): `useEffectiveTimeRange`, `PageRefreshProvider` (Reload
// re-resolves unsnapped and spins 600 ms) and `TimeRangeHeaderControls`. The page owns its search;
// the frame reports a resolved window or a new time search as OutMessages.

export const Model = Schema.Struct({
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	/** The browser's locale, read with the window, for `toLocaleString` counts. */
	locale: Schema.String,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
	timePicker: TimeRangePicker.Model,
})
export type Model = typeof Model.Type

export const init = (id: string): Model => ({
	window: null,
	nowMs: 0,
	locale: INITIAL_LOCALE,
	refreshVersion: 0,
	isReloading: false,
	timePicker: TimeRangePicker.init(id),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: {
		window: TimeWindow,
		nowMs: Schema.Number,
		locale: Schema.String,
		mode: RequestMode,
	},
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedResetTimeRange: {},
	GotTimePickerMessage: { message: TimeRangePicker.Message },
})
export type Message = typeof Message.Type

const TimeSearchSchema = Schema.Struct({
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
})

export const OutMessage = defineMessageUnion({
	/** A window resolved: the page (re)requests its data with this mode. */
	ResolvedWindow: { mode: RequestMode },
	/** The picker or reset chose a new window: the page writes it to its URL. */
	ChangedTimeSearch: { search: TimeSearchSchema },
})
export type OutMessage = typeof OutMessage.Type

/** What a resolve needs from the page: its URL window, default preset and the viewer's zone. */
export type Scope = Readonly<{ search: TimeSearch; defaultPreset: PresetValue; timeZone: string }>

/** The URL window a resolve reads: its bounds or preset, and the viewer's zone. */
export const WindowArgs = {
	mode: RequestMode,
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	preset: Schema.String,
	timeZone: Schema.String,
}

/** A page's own resolve Command (`useEffectiveTimeRange`): snapped on `Load`, unsnapped on `Refresh`. */
export const resolveWindowCommand = <const Name extends string, const Tag extends string>(
	name: Name,
	completed: CallableTaggedStruct<
		Tag,
		{
			readonly window: typeof TimeWindow
			readonly nowMs: Schema.Number
			readonly mode: typeof RequestMode
		}
	>,
) =>
	Command.define(name, {
		args: WindowArgs,
		messages: [completed],
		execute: ({ mode, startTime, endTime, preset, timeZone }) =>
			Effect.map(Clock.currentTimeMillis, (nowMs) =>
				completed({
					window: resolveWindow(
						{ startTime, endTime, preset, snap: mode === "Load", timeZone },
						nowMs,
					),
					nowMs,
					mode,
				}),
			),
	})

export const ResolveWindow = Command.define("ResolveInfraWindow", {
	args: WindowArgs,
	messages: [Message.CompletedResolveWindow],
	execute: ({ mode, startTime, endTime, preset, timeZone }) =>
		Effect.zipWith(Clock.currentTimeMillis, readLocale, (nowMs, locale) =>
			Message.CompletedResolveWindow({
				window: resolveWindow({ startTime, endTime, preset, snap: mode === "Load", timeZone }, nowMs),
				nowMs,
				locale,
				mode,
			}),
		),
})

export const CompleteReloadSpin = reloadSpin("CompleteInfraReloadSpin", Message.CompletedReloadSpin)

export type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const timeSearchOf = (search: TimeSearch) => ({
	startTime: search.startTime,
	endTime: search.endTime,
	timePreset: search.timePreset,
})

export const update = (model: Model, message: Message, scope: Scope): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, locale, mode }) => ({
			model: { ...model, window, nowMs, locale },
			outMessage: OutMessage.ResolvedWindow({ mode }),
		}),
		ClickedReload: () => {
			const next = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
			return {
				model: next,
				commands: [
					resolve(next, scope, "Refresh"),
					CompleteReloadSpin({ version: next.refreshVersion }),
				],
			}
		},
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		ClickedResetTimeRange: () => ({
			model,
			outMessage: OutMessage.ChangedTimeSearch({
				search: { startTime: undefined, endTime: undefined, timePreset: scope.defaultPreset },
			}),
		}),
		GotTimePickerMessage: ({ message: inner }) => {
			const next = TimeRangePicker.update(model.timePicker, inner)
			const lifted = {
				model: { ...model, timePicker: next.model },
				commands: Command.mapMessages(next.commands, (picker) =>
					Message.GotTimePickerMessage({ message: picker }),
				),
			}
			// `applyTimeRangeSearch` with a preset: the absolute bounds leave the URL.
			return next.outMessage === undefined || next.outMessage._tag === "RejectedRange"
				? lifted
				: {
						...lifted,
						outMessage: OutMessage.ChangedTimeSearch({
							search: {
								...timeSearchOf(scope.search),
								...TimeRangePicker.searchPatchOf(next.outMessage),
							},
						}),
					}
		},
	})

/** The header's time cluster: picker, reset for a custom range, Reload. */
export const controls = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	scope: Pick<Scope, "search" | "defaultPreset">,
	toParent: (message: Message) => M,
	/** True while the page's failure card shows, so its Try again is the only retry. */
	isFailed = false,
): Html =>
	timeControls(h, {
		isReloadHidden: isFailed,
		search: scope.search,
		defaultPreset: scope.defaultPreset,
		window: model.window,
		onReset: toParent(Message.ClickedResetTimeRange()),
		onReload: toParent(Message.ClickedReload()),
		isReloading: model.isReloading,
		trigger: (label) =>
			h.submodel({
				slotId: "time-range-picker",
				model: model.timePicker,
				view: TimeRangePicker.view,
				toParentMessage: (message: TimeRangePicker.Message) =>
					toParent(Message.GotTimePickerMessage({ message })),
				viewInputs: {
					label,
					selectedPreset:
						scope.search.timePreset ??
						(scope.search.startTime === undefined ? scope.defaultPreset : undefined),
					presets: TimeRangePicker.PRESET_VALUES,
				},
			}),
	})

/** Resolve for `scope`: snapped on entry, unsnapped after a Reload (`refreshVersion > 0`). */
export const resolve = (model: Model, scope: Scope, mode?: RequestMode) =>
	ResolveWindow({
		mode: mode ?? (model.refreshVersion === 0 ? "Load" : "Refresh"),
		startTime: scope.search.startTime,
		endTime: scope.search.endTime,
		preset: scope.search.timePreset ?? scope.defaultPreset,
		timeZone: scope.timeZone,
	})
