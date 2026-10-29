import { Clock, Duration, Effect, Layer, Schema } from "effect"
import { Block } from "foldkit"
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

const TimeSearchSchema = Schema.Struct({
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
})

/** What a resolve needs from the page: its URL window, default preset and the viewer's zone. */
export const Scope = Schema.Struct({
	search: TimeSearchSchema,
	defaultPreset: Schema.String,
	timeZone: Schema.String,
})
export type Scope = typeof Scope.Type

/** Only the window fields of a page search: the frame keeps nothing else. */
const timeSearchOf = (search: TimeSearch) => ({
	startTime: search.startTime,
	endTime: search.endTime,
	timePreset: search.timePreset,
})

const scopeOf = (scope: Scope) => ({ ...scope, search: timeSearchOf(scope.search) })

export const Model = Schema.Struct({
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	/** The browser's locale, read with the window, for `toLocaleString` counts. */
	locale: Schema.String,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
	/** The page scope of the last resolve (or `informOfScope`), which Reload and the picker read. */
	scope: Scope,
	timePicker: TimeRangePicker.TimeRangePickerBlock.Model,
})
export type Model = typeof Model.Type

export const init = (id: string, scope: Scope): Model => ({
	window: null,
	nowMs: 0,
	locale: INITIAL_LOCALE,
	refreshVersion: 0,
	isReloading: false,
	scope: scopeOf(scope),
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
	/** The page (re)resolves for `scope`: snapped on entry, unsnapped after a Reload unless `mode` says. */
	RequestedResolve: { scope: Scope, mode: Schema.optionalKey(RequestMode) },
	/** The page scope moved without a resolve (a time zone change): Reload and the picker read it. */
	InformedOfScope: { scope: Scope },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	/** A window resolved: the page (re)requests its data with this mode. */
	ResolvedWindow: { mode: RequestMode },
	/** The picker or reset chose a new window: the page writes it to its URL. */
	ChangedTimeSearch: { search: TimeSearchSchema },
})
export type OutMessage = typeof OutMessage.Type

// DEFINITION

const FrameDefinition = Block.makeDefinition("InfraFrame", { Model, Message, OutMessage })
const { makeStep, makeNoopStep } = FrameDefinition

// COMMANDS

export const ResolveWindow = FrameDefinition.makeCommand("ResolveInfraWindow", {
	args: {
		mode: RequestMode,
		startTime: Schema.optional(Schema.String),
		endTime: Schema.optional(Schema.String),
		preset: Schema.String,
		timeZone: Schema.String,
	},
	messages: [Message.CompletedResolveWindow],
	handler: function* () {
		return ({ mode, startTime, endTime, preset, timeZone }) =>
			Effect.zipWith(Clock.currentTimeMillis, readLocale, (nowMs, locale) =>
				Message.CompletedResolveWindow({
					window: resolveWindow(
						{ startTime, endTime, preset, snap: mode === "Load", timeZone },
						nowMs,
					),
					nowMs,
					locale,
					mode,
				}),
			)
	},
})

const RELOAD_SPIN = Duration.millis(600)

export const CompleteReloadSpin = FrameDefinition.makeCommand("CompleteInfraReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	handler: function* () {
		return ({ version }) => Effect.as(Effect.sleep(RELOAD_SPIN), Message.CompletedReloadSpin({ version }))
	},
})

/** Resolve for the kept scope: snapped on entry, unsnapped after a Reload (`refreshVersion > 0`). */
const resolve = (model: Model, mode?: RequestMode) =>
	ResolveWindow({
		mode: mode ?? (model.refreshVersion === 0 ? "Load" : "Refresh"),
		startTime: model.scope.search.startTime,
		endTime: model.scope.search.endTime,
		preset: model.scope.search.timePreset ?? model.scope.defaultPreset,
		timeZone: model.scope.timeZone,
	})

// BINDINGS

/** `applyTimeRangeSearch` with a preset: the absolute bounds leave the URL. */
const changedSearchStep = (patch: TimeRangePicker.TimeSearchPatch) =>
	makeStep((model) => ({
		model,
		outMessage: OutMessage.ChangedTimeSearch({ search: { ...model.scope.search, ...patch } }),
	}))

/** `init` builds the picker itself; a refused range has no maximum here, so it is dropped. */
const TimePickerBinding = FrameDefinition.makeBinding(TimeRangePicker.TimeRangePickerBlock, {
	field: "timePicker",
	init: false,
}).withOutMessagePolicy({
	fold: FrameDefinition.makeOutMessageFold(TimeRangePicker.TimeRangePickerBlock, {
		SelectedPreset: (out) => changedSearchStep(TimeRangePicker.searchPatchOf(out)),
		SelectedCustomRange: (out) => changedSearchStep(TimeRangePicker.searchPatchOf(out)),
		RejectedRange: () => makeNoopStep(),
	}),
})

export const FrameComposition = FrameDefinition.makeComposition({ bindings: [TimePickerBinding] })

// UPDATE

export const update = FrameComposition.makeUpdate({
	CompletedResolveWindow: (model, { window, nowMs, locale, mode }) => ({
		model: { ...model, window, nowMs, locale },
		outMessage: OutMessage.ResolvedWindow({ mode }),
	}),
	ClickedReload: (model) => {
		const next = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
		return {
			model: next,
			commands: [resolve(next, "Refresh"), CompleteReloadSpin({ version: next.refreshVersion })],
		}
	},
	CompletedReloadSpin: (model, { version }) =>
		version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
	ClickedResetTimeRange: (model) => ({
		model,
		outMessage: OutMessage.ChangedTimeSearch({
			search: { startTime: undefined, endTime: undefined, timePreset: model.scope.defaultPreset },
		}),
	}),
	RequestedResolve: (model, { scope, mode }) => {
		const next = { ...model, scope: scopeOf(scope) }
		return { model: next, commands: [resolve(next, mode)] }
	},
	InformedOfScope: (model, { scope }) => ({ model: { ...model, scope: scopeOf(scope) } }),
})

// VIEW

export type ViewInputs = Readonly<{
	/** The page's current search and default preset, which the header reflects. */
	search: TimeSearch
	defaultPreset: string
	/** True while the page's failure card shows, so its Try again is the only retry. */
	isFailed?: boolean
}>

/** The header's time cluster: picker, reset for a custom range, Reload. */
export const view = FrameComposition.makeView.withInputs<ViewInputs>((model, inputs, h) =>
	timeControls(h, {
		isReloadHidden: inputs.isFailed === true,
		search: inputs.search,
		defaultPreset: inputs.defaultPreset,
		window: model.window,
		onReset: Message.ClickedResetTimeRange(),
		onReload: Message.ClickedReload(),
		isReloading: model.isReloading,
		trigger: (label) =>
			h.block(
				TimePickerBinding.embedView({
					slotId: "time-range-picker",
					model: model.timePicker,
					viewInputs: {
						label,
						selectedPreset:
							inputs.search.timePreset ??
							(inputs.search.startTime === undefined ? inputs.defaultPreset : undefined),
						presets: TimeRangePicker.PRESET_VALUES,
					},
				}),
			),
	}),
)

const prepare = () =>
	FrameComposition.prepareBlock({
		init: FrameComposition.makeInit((id: string, scope: Scope) => ({ model: init(id, scope) })),
		update,
		view,
		operations: {
			requestResolve: Message.RequestedResolve,
			informOfScope: Message.InformedOfScope,
		},
		EffectsLayer: Layer.mergeAll(ResolveWindow.layer, CompleteReloadSpin.layer),
	})
export const FrameBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)

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
