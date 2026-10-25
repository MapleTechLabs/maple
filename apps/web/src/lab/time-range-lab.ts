import { resolveRelativeRangeToWarehouse } from "@maple/query-engine"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { Clock, Effect, Option, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { readEffectiveTimeZone, readSelectedTimeZone } from "../platform/time-zone"
import { presetLabel } from "../page/kit/time-controls"
import { dashboardPage } from "../page/kit/dashboard-page"
import * as TimeRangePicker from "../page/kit/time-range-picker"
import { kbd } from "../ui/display"

// The header time range picker over plain state, and a strip
// printing the window and two fixed instants in the effective zone.

export const Range = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	presetValue: Schema.NullOr(Schema.String),
})
export type Range = typeof Range.Type

export const Model = Schema.Struct({
	picker: TimeRangePicker.Model,
	range: Schema.NullOr(Range),
	selectedTimeZone: Schema.NullOr(Schema.String),
	effectiveTimeZone: Schema.String,
	/** The boot clock: the zone's UTC offset is the one in force then. */
	nowMs: Schema.Number,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotPickerMessage: { message: TimeRangePicker.Message },
	CompletedResolveRange: { range: Schema.NullOr(Range) },
})
export type Message = typeof Message.Type

export const Flags = Schema.Struct({
	nowMs: Schema.Number,
	selectedTimeZone: Schema.NullOr(Schema.String),
	effectiveTimeZone: Schema.String,
})
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.all({
	nowMs: Clock.currentTimeMillis,
	selectedTimeZone: Effect.map(readSelectedTimeZone, Option.getOrNull),
	effectiveTimeZone: readEffectiveTimeZone,
})

/** `relativeToAbsolute` at `nowMs` in the zone, with the preset it came from. */
const rangeOf = (presetValue: string, nowMs: number, timeZone: string): Range | null => {
	const resolved = resolveRelativeRangeToWarehouse(presetValue, nowMs, timeZone)
	return resolved === null ? null : { ...resolved, presetValue }
}

const ResolveRange = Command.define("ResolveLabTimeRange", {
	args: { presetValue: Schema.String, timeZone: Schema.String },
	messages: [Message.CompletedResolveRange],
	execute: ({ presetValue, timeZone }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) =>
			Message.CompletedResolveRange({ range: rangeOf(presetValue, nowMs, timeZone) }),
		),
})

type Return = Update.Return<Model, Message>

/** `PRESET_OPTIONS[0]`: the last five minutes. */
export const init = (flags: Flags): Return => ({
	model: {
		picker: TimeRangePicker.init("lab-time-range"),
		range: rangeOf("5m", flags.nowMs, flags.effectiveTimeZone),
		selectedTimeZone: flags.selectedTimeZone,
		effectiveTimeZone: flags.effectiveTimeZone,
		nowMs: flags.nowMs,
	},
})

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotPickerMessage: ({ message: inner }) => {
			const next = TimeRangePicker.update(model.picker, inner)
			const commands = Command.mapMessages(next.commands ?? [], (child) =>
				Message.GotPickerMessage({ message: child }),
			)
			const picker = { ...model, picker: next.model }
			// `setRange`: a custom range is stored as picked, with no preset.
			if (next.outMessage?._tag === "SelectedCustomRange")
				return { model: { ...picker, range: { startTime: next.outMessage.startTime, endTime: next.outMessage.endTime, presetValue: null } }, commands }
			return {
				model: picker,
				commands:
					next.outMessage === undefined || next.outMessage._tag === "RejectedRange"
						? commands
						: [
								...commands,
								ResolveRange({
									presetValue: next.outMessage.presetValue,
									timeZone: model.effectiveTimeZone,
								}),
							],
			}
		},
		CompletedResolveRange: ({ range }) => ({ model: { ...model, range } }),
	})

/** The strip's rows: the window and two fixed instants in the effective zone. */
export const rowsOf = (model: Model) => {
	const zone = model.effectiveTimeZone
	const inZone = (value: string | undefined) =>
		value === undefined ? undefined : formatTimestampInTimezone(value, { timeZone: zone })
	return [
		{ label: "Preference", value: model.selectedTimeZone ?? "System" },
		{ label: "Effective zone", value: `${zone} (${TimeRangePicker.formatUtcOffset(zone, model.nowMs)})` },
		{ label: "Preset", value: model.range?.presetValue ?? "—" },
		{ label: "Start (warehouse)", value: model.range?.startTime },
		{ label: "End (warehouse)", value: model.range?.endTime },
		{ label: "Start (in zone)", value: inZone(model.range?.startTime) },
		{ label: "End (in zone)", value: inZone(model.range?.endTime) },
		{ label: "2026-01-01 00:00:00Z", value: inZone("2026-01-01T00:00:00Z") },
		{ label: "2026-07-01 12:00:00Z", value: inZone("2026-07-01T12:00:00Z") },
	]
}

export const view = (model: Model, h: HtmlBuilder<Message>): Html => {
	const preset = model.range?.presetValue ?? undefined
	return dashboardPage(
		h,
		{
			actions: h.submodel({
				slotId: "time-range-picker",
				model: model.picker,
				view: TimeRangePicker.view,
				toParentMessage: (message) => Message.GotPickerMessage({ message }),
				viewInputs: {
					label: preset === undefined ? "Time range" : presetLabel(preset),
					selectedPreset: preset,
					presets: TimeRangePicker.PRESET_VALUES,
					timeZone: model.effectiveTimeZone,
					startTime: model.range?.startTime,
					endTime: model.range?.endTime,
				},
			}),
		},
		[
			h.div(
				[h.Class("mx-auto w-full max-w-2xl p-4")],
				[
					h.dl(
						[h.Class("divide-y divide-border/60 rounded-lg border border-border/70")],
						rowsOf(model).map((row) =>
							h.div(
								[
									h.Key(row.label),
									h.Class("flex items-baseline justify-between gap-6 px-3 py-2"),
								],
								[
									h.dt([h.Class("text-xs text-muted-foreground")], [row.label]),
									h.dd(
										[h.Class("font-mono text-xs tabular-nums text-foreground/90")],
										[row.value ?? "—"],
									),
								],
							),
						),
					),
					h.p(
						[h.Class("mt-3 text-xs text-muted-foreground")],
						[
							"Press ",
							kbd(h, undefined, ["D"]),
							" to open the picker. The timezone choice is stored in localStorage and applies app-wide.",
						],
					),
				],
			),
		],
	)
}
