import type { OnCallShift } from "@maple/alerting-core/oncall"
import { OnCallTimeZone } from "@maple/domain/http"
import { zonedDayStart } from "@maple/views/ui/shift-timeline"
import { Array as Arr, Option, Schema, String as Str } from "effect"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import {
	coveragePreview,
	type PreviewNote,
	type PreviewShift,
	type RangeDays,
} from "../shared/coverage-preview"
import { memberName, type OrgMember } from "../shared/org-members"
import { draftCoverage, layerOnCallAt, previewLayerOf, previewRange } from "../shared/schedule-coverage"
import { layerStartMs, type LayerDraft } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { PREVIEW_SCOPE } from "./update"

// The editor's live coverage preview: the draft rendered as it is edited, no save needed.

const isZone = Schema.is(OnCallTimeZone)

const layerName = (name: string, index: number) =>
	Str.trim(name) === "" ? `Layer ${index + 1}` : Str.trim(name)

/** What the preview reads off the Model; it redraws only when one of these changes. */
export type PreviewInputs = Readonly<{
	timeZone: string
	layers: ReadonlyArray<LayerDraft>
	members: ReadonlyArray<OrgMember> | null
	nowMs: number
	/** A new schedule: its starts are the user's own, so an early one is worth explaining. */
	isNew: boolean
}>

/** Plain-language notes on the draft's layers, one per thing the preview cannot say by itself. */
export const previewNotes = (inputs: PreviewInputs): ReadonlyArray<PreviewNote> => {
	const todayMs = isZone(inputs.timeZone) ? zonedDayStart(inputs.nowMs, inputs.timeZone) : inputs.nowMs
	return Arr.flatMap(inputs.layers, (layer, index): ReadonlyArray<PreviewNote> => {
		const name = layerName(layer.name, index)
		if (layer.participants.length === 0)
			return [{ tone: "warn", text: `${name} has no people, so it covers nothing.` }]
		// A saved schedule's start is always behind it, and a new layer starts today by default.
		const startedEarlier =
			inputs.isNew && Option.exists(layerStartMs(layer, inputs.timeZone), (ms) => ms < todayMs)
		if (!startedEarlier) return []
		const under = `${name} started before today, so the rotation is already under way`
		return [
			{
				tone: "info",
				text: Option.match(layerOnCallAt(layer, inputs.timeZone, inputs.nowMs), {
					onNone: () => `${under}.`,
					onSome: (userId) => `${under}: ${memberName(inputs.members, userId)} is on call now.`,
				}),
			},
		]
	})
}

const asPreview = (shift: OnCallShift): PreviewShift => ({
	userId: shift.userId,
	startMs: shift.startMs,
	endMs: shift.endMs,
	isOverride: shift.source.kind === "override",
})

const render = (
	h: HtmlBuilder<Message>,
	zone: string,
	layers: ReadonlyArray<LayerDraft>,
	members: ReadonlyArray<OrgMember> | null,
	nowMs: number,
	weekOffset: number,
	rangeDays: RangeDays,
	isNew: boolean,
): Html => {
	const timeZone = isZone(zone) ? zone : "UTC"
	const range = previewRange(nowMs, timeZone, weekOffset, Number(rangeDays))
	const coverage = draftCoverage({ timeZone: zone, layers }, [], range.startMs, range.endMs, nowMs)
	return coveragePreview(h, {
		scope: PREVIEW_SCOPE,
		title: "Coverage preview",
		timeZone,
		fromMs: range.startMs,
		toMs: range.endMs,
		nowMs,
		weekOffset,
		rangeDays,
		lanes: Arr.map(layers, (layer, index) => ({
			key: layer.key,
			label: layerName(layer.name, index),
			detail: `Layer ${index + 1}`,
			shifts: Option.map(coverage.layers[index] ?? Option.none(), Arr.map(asPreview)),
			emptyText:
				layer.participants.length === 0
					? "Add people to see shifts"
					: Option.isNone(previewLayerOf(layer, timeZone))
						? "Fix this layer to see shifts"
						: "Not active in this period",
		})),
		final: Arr.map(coverage.final, asPreview),
		gaps: coverage.gaps,
		nameOf: (userId) => memberName(members, userId),
		onPrevious: Message.ClickedPreviewPrevious(),
		onNext: Message.ClickedPreviewNext(),
		onToday: Message.ClickedPreviewToday(),
		onRange: (days) => Message.PickedPreviewRange({ days }),
		onFocusGap: (index) => Message.ClickedPreviewGap({ index }),
		// A draft has no past to look back on.
		isPreviousDisabled: weekOffset <= 0,
		notes: previewNotes({ timeZone: zone, layers, members, nowMs, isNew }),
		note: isNew ? undefined : "Overrides are not shown here.",
	})
}

const slot = createLazy()

const MINUTE_MS = 60_000

/** Redrawn only when the zone, the layers, the members, the minute or the range change, not on every key. */
export const schedulePreview = (h: HtmlBuilder<Message>, model: Model): Html =>
	slot(render, [
		h,
		model.form.timeZone,
		model.form.layers,
		model.members,
		Math.floor(model.nowMs / MINUTE_MS) * MINUTE_MS,
		model.previewWeekOffset,
		model.previewRange,
		model.editingId === null,
	])
