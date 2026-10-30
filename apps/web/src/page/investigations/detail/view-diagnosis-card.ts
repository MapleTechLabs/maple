import { TraceId } from "@maple/domain"
import type { AiTriageResult } from "@maple/domain/http"
import type { V2Investigation } from "@maple/domain/http/v2"
import { Option, Schema } from "effect"
import { classifyAction } from "@maple/web-data/investigations/action-target"
import type { ActionNodeData } from "@maple/web-data/investigations/provenance-graph"
import type { Html, HtmlBuilder } from "foldkit/html"
import { card } from "../../../ui/card"
import * as DialogView from "../../../ui/dialog-view"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { CONFIDENCE_TONE } from "../kit"
import { Message } from "./message"
import type { Model } from "./model"
import { actionSheetContent } from "./view-action-sheet"
import { ACTION_GLYPH } from "./view-canvas"
import { evidenceChips, type TipTrigger } from "./view-sections"

// `DiagnosisReportCard`: the report an investigation's
// Chat and Transcript tabs lead with until the thread's own `submit_diagnosis` turn lands. Its
// action rows open the action sheet from local state, not `?action=`.

type H = HtmlBuilder<Message>
type Report = NonNullable<V2Investigation["report"]>

const decodeTraceId = Schema.decodeUnknownOption(TraceId)

/** A thread's `submit_diagnosis` report in the investigation's shape (trace ids branded, invalid ones dropped). */
export const reportOfDiagnosis = (report: AiTriageResult): Report => ({
	...(report.headline === undefined ? undefined : { headline: report.headline }),
	...(report.severityAssessment === undefined ? undefined : { severityAssessment: report.severityAssessment }),
	...(report.ruledOut === undefined ? undefined : { ruledOut: report.ruledOut }),
	...(report.unchecked === undefined ? undefined : { unchecked: report.unchecked }),
	summary: report.summary,
	suspectedCause: report.suspectedCause,
	affectedScope: report.affectedScope,
	suggestedActions: report.suggestedActions,
	confidence: report.confidence,
	evidence: report.evidence.map((item) => ({
		traceIds: item.traceIds.flatMap((id) => Option.toArray(decodeTraceId(id))),
		logPatterns: item.logPatterns,
		relatedServices: item.relatedServices,
		note: item.note,
	})),
})

/** The report's actions as the card routes them: by the affected scope alone. */
export const reportActions = (report: Report): ReadonlyArray<ActionNodeData> =>
	report.suggestedActions.map((text, index) => ({
		index,
		ordinal: String(index + 1).padStart(2, "0"),
		text,
		...classifyAction(text, { scope: report.affectedScope }),
		promise: index === report.suggestedActions.length - 1 ? "PULL REQ · SOON" : "AUTOFIX · SOON",
	}))

/** The card's own action sheet: the whole action and its evidence, from the card's local choice. */
const reportSheet = (h: H, model: Model, report: Report, trigger: TipTrigger): Html => {
	const action = reportActions(report).find((candidate) => candidate.index === model.reportActionIndex) ?? null
	const dialogId = model.reportSheet.id
	return h.submodel({
		slotId: `${dialogId}-slot`,
		model: model.reportSheet,
		view: DialogView.view,
		viewInputs: {
			className: "sm:max-w-lg",
			side: "right",
			hasTrigger: false,
			hasDescription: action !== null,
			toView: ({ portal }) => portal,
			toContent: () => (action === null ? [] : actionSheetContent(h, dialogId, action, report, trigger)),
		},
		toParentMessage: (message) => Message.GotReportSheetMessage({ message }),
	})
}

/** `DiagnosisReportCard`: cause, summary, scope, evidence and the recommended actions. */
export const diagnosisReportCard = (h: H, model: Model, report: Report, trigger: TipTrigger): Html => {
	const evidence = report.evidence.filter((item) => item.note || item.traceIds.length > 0 || item.logPatterns.length > 0)
	const actions = reportActions(report)
	return card(
		h,
		[
			h.header(
				[h.Class("space-y-1.5")],
				[
					h.div(
						[h.Class("flex items-center gap-1.5")],
						[
							icon(h, "PulseIcon", { className: "size-3.5 text-muted-foreground" }),
							eyebrow(h, { variant: "label" }, ["AI Diagnosis"]),
							h.span([h.Class("text-foreground-faint")], ["·"]),
							h.span(
								[h.Class(`text-2xs font-medium capitalize ${CONFIDENCE_TONE[report.confidence] ?? ""}`)],
								[report.confidence, " confidence"],
							),
						],
					),
					h.h3(
						[h.Class("font-display text-lg font-semibold leading-snug tracking-tight text-foreground")],
						[report.suspectedCause],
					),
					h.p([h.Class("text-sm leading-relaxed text-muted-foreground")], [report.summary]),
				],
			),
			...(report.affectedScope
				? [
						h.p(
							[h.Class("text-xs text-muted-foreground")],
							[h.span([h.Class("font-medium text-foreground")], ["Scope:"]), " ", report.affectedScope],
						),
					]
				: []),
			...(evidence.length === 0
				? []
				: [
						h.section(
							[h.Class("space-y-2")],
							[
								eyebrow(h, { variant: "label", as: "h4" }, ["Evidence"]),
								...evidence.map((item, index) => {
									const chips = evidenceChips(h, item, "card", trigger)
									return h.keyed("div")(String(index), [h.Class("space-y-1.5 rounded-md bg-surface-sunken p-3")], [
										...(item.note ? [h.p([h.Class("text-sm leading-relaxed text-foreground")], [item.note])] : []),
										...(chips === null ? [] : [chips]),
									])
								}),
							],
						),
					]),
			...(actions.length === 0
				? []
				: [
						h.section(
							[h.Class("space-y-2")],
							[
								eyebrow(h, { variant: "label", as: "h4" }, ["Recommended actions"]),
								h.ol([h.Class("space-y-1")], actions.map((action) => actionRow(h, action))),
							],
						),
					]),
			reportSheet(h, model, report, trigger),
		],
		"gap-4 border-primary/20 bg-card/60 p-5",
	)
}

const actionRow = (h: H, action: ActionNodeData): Html => {
	const glyph = ACTION_GLYPH[action.kind]
	return h.keyed("li")(
		action.text,
		[],
		[
			h.button(
				[
					h.Class(
						"-mx-2 flex w-[calc(100%+1rem)] items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-sunken",
					),
					h.Type("button"),
					h.OnClick(Message.ClickedReportAction({ index: action.index })),
				],
				[
					h.span(
						[
							h.Class(
								"mt-px flex size-5 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-2xs tabular-nums text-muted-foreground",
							),
						],
						[String(action.index + 1)],
					),
					icon(h, glyph.icon, {
						size: 14,
						className: "mt-1 shrink-0 text-muted-foreground",
						attributes: [h.AriaLabel(glyph.label)],
					}),
					h.span([h.Class("min-w-0 flex-1 text-sm leading-relaxed text-foreground")], [action.text]),
					icon(h, "ChevronRightIcon", { size: 14, className: "mt-1 shrink-0 text-foreground-faint" }),
				],
			),
		],
	)
}
