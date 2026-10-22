import { Clock, Duration, Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { resolveWindow, TimeWindow } from "../../../data/time-range"
import { timeControls, type TimeSearch } from "../../kit/time-controls"
import { INITIAL_LOCALE, readLocale } from "../../kit/locale"
import * as TimeRangePicker from "../../kit/time-range-picker"

// The time scope every infra page shares: `useEffectiveTimeRange`, `PageRefreshProvider` (Reload
// re-resolves unsnapped and spins 600 ms) and `TimeRangeHeaderControls`. The page owns its search;
// the frame reports a resolved window or a new time search as OutMessages.

export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

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
export type Scope = Readonly<{ search: TimeSearch; defaultPreset: string; timeZone: string }>

export const ResolveWindow = Command.define("ResolveInfraWindow", {
	args: {
		mode: RequestMode,
		startTime: Schema.optional(Schema.String),
		endTime: Schema.optional(Schema.String),
		preset: Schema.String,
		timeZone: Schema.String,
	},
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

const RELOAD_SPIN = Duration.millis(600)

export const CompleteReloadSpin = Command.define("CompleteInfraReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) => Effect.as(Effect.sleep(RELOAD_SPIN), Message.CompletedReloadSpin({ version })),
})

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
): Html =>
	timeControls(h, {
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

// `WIDEN_TIME_PRESET` / `canWidenTimeRange`: the preset an empty page offers to widen to.
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

/** Resolve for `scope`: snapped on entry, unsnapped after a Reload (`refreshVersion > 0`). */
export const resolve = (model: Model, scope: Scope, mode?: RequestMode) =>
	ResolveWindow({
		mode: mode ?? (model.refreshVersion === 0 ? "Load" : "Refresh"),
		startTime: scope.search.startTime,
		endTime: scope.search.endTime,
		preset: scope.search.timePreset ?? scope.defaultPreset,
		timeZone: scope.timeZone,
	})
