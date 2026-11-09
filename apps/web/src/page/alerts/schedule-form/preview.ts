import { Array as Arr, Option, Schema, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { OnCallTimeZone } from "@maple/domain/http"
import { coveragePreview, type PreviewShift } from "../shared/coverage-preview"
import { memberName } from "../shared/org-members"
import { draftCoverage, previewLayerOf, previewRange } from "../shared/schedule-coverage"
import { localInputMs } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { PREVIEW_SCOPE } from "./update"

// The editor's live coverage preview: the draft rendered on every edit, no save needed.

const isZone = Schema.is(OnCallTimeZone)

const layerName = (name: string, index: number) =>
	Str.trim(name) === "" ? `Layer ${index + 1}` : Str.trim(name)

/** Plain-language notes on the draft's layers, one per issue that changes the preview. */
export const previewWarnings = (model: Pick<Model, "form" | "nowMs">): ReadonlyArray<string> =>
	Arr.flatMap(model.form.layers, (layer, index) => {
		const name = layerName(layer.name, index)
		if (layer.participants.length === 0) return [`${name} has no people, so it covers nothing.`]
		const startMs =
			layer.startsAtMs === null
				? localInputMs(layer.startsAt, model.form.timeZone)
				: Option.some(layer.startsAtMs)
		return Option.exists(startMs, (ms) => ms < model.nowMs)
			? [`${name} starts in the past. Shifts are scheduled from now, keeping its rotation order.`]
			: []
	})

const asPreview = (shift: {
	userId: string
	startMs: number
	endMs: number
	source: { kind: string }
}): PreviewShift => ({
	userId: shift.userId,
	startMs: shift.startMs,
	endMs: shift.endMs,
	isOverride: shift.source.kind === "override",
})

export const schedulePreview = (h: HtmlBuilder<Message>, model: Model): Html => {
	const timeZone = isZone(model.form.timeZone) ? model.form.timeZone : "UTC"
	const days = Number(model.previewRange)
	const range = previewRange(model.nowMs, timeZone, model.previewWeekOffset, days)
	const coverage = draftCoverage(model.form, [], range.startMs, range.endMs, model.nowMs)
	return coveragePreview(h, {
		scope: PREVIEW_SCOPE,
		title: "Coverage preview",
		timeZone,
		fromMs: range.startMs,
		toMs: range.endMs,
		nowMs: model.nowMs,
		weekOffset: model.previewWeekOffset,
		rangeDays: model.previewRange,
		lanes: Arr.map(model.form.layers, (layer, index) => ({
			key: layer.key,
			label: layerName(layer.name, index),
			detail: `Layer ${index + 1}`,
			shifts: Option.map(coverage.layers[index] ?? Option.none(), Arr.map(asPreview)),
			emptyText:
				layer.participants.length === 0
					? "Add people to see shifts"
					: Option.isNone(previewLayerOf(layer, timeZone))
						? "Fix the rotation to see shifts"
						: "Not active in this period",
		})),
		final: Arr.map(coverage.final, asPreview),
		gaps: coverage.gaps,
		nameOf: (userId) => memberName(model.members, userId),
		onPrevious: Message.ClickedPreviewPrevious(),
		onNext: Message.ClickedPreviewNext(),
		onToday: Message.ClickedPreviewToday(),
		onRange: (days) => Message.PickedPreviewRange({ days }),
		onFocusGap: (index) => Message.ClickedPreviewGap({ index }),
		warnings: previewWarnings(model),
		note: `Times in ${timeZone}. Overrides are not shown here.`,
	})
}
