import type { OnCallShift } from "@maple/alerting-core/oncall"
import { OnCallOverride, OnCallTimeZone } from "@maple/domain/http"
import type { V2OnCallOverride } from "@maple/domain/http/v2"
import { skeleton } from "@maple/views/ui/skeleton"
import { zonedDayStart } from "@maple/views/ui/shift-timeline"
import { Array as Arr, Option, Schema, String as Str } from "effect"
import { AsyncData } from "foldkit"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import {
	coveragePreview,
	type PreviewNote,
	type PreviewShift,
	type RangeDays,
} from "../shared/coverage-preview"
import { memberName, type OrgMember } from "../shared/org-members"
import { draftCoverage, layerOnCallAt, previewLayerOf, previewRange } from "../shared/schedule-coverage"
import { isoMs } from "../shared/time"
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

const decodeOverride = Schema.decodeUnknownResult(OnCallOverride)

/** The API's overrides as the engine reads them; one it cannot read (a bad instant) is left out. */
export const engineOverrides = (overrides: ReadonlyArray<V2OnCallOverride>): ReadonlyArray<OnCallOverride> =>
	Arr.filterMap(overrides, (override) =>
		decodeOverride({
			id: override.id,
			userId: override.user_id,
			startsAt: isoMs(override.starts_at),
			endsAt: isoMs(override.ends_at),
			createdAt: isoMs(override.created_at),
		}),
	)

/**
 * Where the edited schedule's overrides stand: `ready` (a new schedule has none), `loading`
 * (nothing can be said about gaps yet), or `failed` / `retrying` (the preview goes on without them).
 */
export type OverridesState = "ready" | "loading" | "failed" | "retrying"

const NO_OVERRIDES: ReadonlyArray<V2OnCallOverride> = []

export const overridesStateOf = (model: Pick<Model, "editingId" | "overrides">): OverridesState =>
	model.editingId === null
		? "ready"
		: AsyncData.isFailure(model.overrides.data)
			? model.overrides.retrying === true
				? "retrying"
				: "failed"
			: Option.isSome(AsyncData.getData(model.overrides.data))
				? "ready"
				: "loading"

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
	overrides: ReadonlyArray<V2OnCallOverride>,
	overridesState: OverridesState,
): Html => {
	const timeZone = isZone(zone) ? zone : "UTC"
	const range = previewRange(nowMs, timeZone, weekOffset, Number(rangeDays))
	// Overrides beat every layer when paging, so the preview layers them over the draft too.
	const coverage = draftCoverage(
		{ timeZone: zone, layers },
		engineOverrides(overrides),
		range.startMs,
		range.endMs,
		nowMs,
	)
	const overridesNote: ReadonlyArray<PreviewNote<Message>> =
		overridesState === "failed" || overridesState === "retrying"
			? [
					{
						tone: "info",
						text: "Overrides could not be loaded, so gaps may be filled.",
						action: {
							label: "Try again",
							onClick: Message.ClickedRetryOverrides(),
							isDisabled: overridesState === "retrying",
						},
					},
				]
			: []
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
		notes: [...overridesNote, ...previewNotes({ timeZone: zone, layers, members, nowMs, isNew })],
		// Until the overrides land nothing can be said about gaps: one may cover them.
		placeholder: overridesState === "loading" ? skeleton(h, "h-40 w-full") : undefined,
	})
}

const slot = createLazy()

const MINUTE_MS = 60_000

/** Redrawn only when the zone, layers, members, overrides, minute or range change, not on every key. */
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
		Option.getOrElse(AsyncData.getData(model.overrides.data), () => NO_OVERRIDES),
		overridesStateOf(model),
	])
