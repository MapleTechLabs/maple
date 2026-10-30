import type { V2Investigation } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"
import type { ActionNodeData } from "@maple/web-data/investigations/provenance-graph"
import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "../../../ui/button"
import * as DialogView from "../../../ui/dialog-view"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { sheetDetailHeader } from "../../kit/sheet-detail-header"
import { CONFIDENCE_TONE } from "../kit"
import { openActionIndexOf } from "./derive"
import { graphOf } from "./graph"
import { Message } from "./message"
import type { Model } from "./model"
import { ACTION_GLYPH } from "./view-canvas"
import { evidenceChips, type TipTrigger } from "./view-sections"

// `ActionDetailSheet`: the whole proposed action,
// the diagnosis behind it and its evidence, keyed by `?action=`.

type H = HtmlBuilder<Message>
type Report = NonNullable<V2Investigation["report"]>

const sectionEyebrow = (h: H, title: string): Html =>
	eyebrow(h, { as: "h3", className: "block mb-0" }, [title])

export const actionSheetContent = (
	h: H,
	dialogId: string,
	action: ActionNodeData,
	report: Report | null,
	trigger: TipTrigger,
): ReadonlyArray<Html> => {
	const glyph = ACTION_GLYPH[action.kind]
	const evidence = (report?.evidence ?? []).filter(
		(item) => item.note || item.traceIds.length > 0 || item.logPatterns.length > 0,
	)
	return [
		sheetDetailHeader(h, {
			dialogId,
			kind: [
				h.span(
					[h.Class("flex items-center gap-2")],
					[
						icon(h, glyph.icon, { size: 12, className: "shrink-0" }),
						"Proposed action ",
						String(action.index + 1).padStart(2, "0"),
						h.span([h.Class("text-foreground-faint")], ["·"]),
						glyph.label,
					],
				),
			],
			mono: false,
			title: [action.text],
			description: "What this proposed action asks for, and the diagnosis behind it.",
		}),
		DialogView.dialogPanel(
			h,
			"sheet",
			dialogId,
			[
				h.div(
					[h.Class("flex flex-wrap items-center gap-2")],
					[
						...(action.target === null
							? []
							: [
									linkButton(
										h,
										{ size: "sm", href: action.target.href, className: "gap-1.5" },
										[action.target.label, icon(h, "ArrowRightIcon")],
									),
								]),
						h.span(
							[
								h.Class(
									"rounded-sm border border-dashed px-2 py-1 text-3xs tracking-wider text-foreground-subtle",
								),
							],
							[action.promise],
						),
					],
				),
				...(report === null
					? []
					: [
							h.section(
								[h.Class("flex flex-col gap-2")],
								[
									sectionEyebrow(h, "From the diagnosis"),
									h.p(
										[h.Class("text-sm leading-relaxed text-foreground")],
										[report.suspectedCause],
									),
									h.p(
										[
											h.Class(
												"flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground",
											),
										],
										[
											h.span(
												[
													h.Class(
														cn(
															"font-medium capitalize",
															CONFIDENCE_TONE[report.confidence],
														),
													),
												],
												[report.confidence, " confidence"],
											),
											...(report.affectedScope
												? [
														h.span([h.Class("text-foreground-faint")], ["·"]),
														h.span([], [report.affectedScope]),
													]
												: []),
										],
									),
								],
							),
						]),
				...(evidence.length === 0
					? []
					: [
							h.section(
								[h.Class("flex flex-col gap-2")],
								[
									sectionEyebrow(h, "Evidence behind the diagnosis"),
									...evidence.map((item, index) => {
										const chips = evidenceChips(h, item, "sheet", trigger)
										return h.keyed("div")(
											String(index),
											[h.Class("flex flex-col gap-1.5 rounded-md bg-surface-sunken p-3")],
											[
												...(item.note
													? [
															h.p(
																[
																	h.Class(
																		"text-sm leading-relaxed text-foreground",
																	),
																],
																[item.note],
															),
														]
													: []),
												...(chips === null ? [] : [chips]),
											],
										)
									}),
								],
							),
						]),
			],
			"flex flex-col gap-6",
		),
	]
}

/** The open action's panel; a stale or mangled `?action=` finds nothing and renders closed. */
export const actionSheet = (
	h: H,
	model: Model,
	investigation: V2Investigation,
	timeZone: string,
	trigger: TipTrigger,
): Html => {
	const index = openActionIndexOf(model)
	const action =
		graphOf(investigation, timeZone).nodes.flatMap((node) =>
			node.type === "action" && node.data.index === index ? [node.data] : [],
		)[0] ?? null
	const dialogId = model.actionSheet.id
	return h.submodel({
		slotId: `${dialogId}-slot`,
		model: model.actionSheet,
		view: DialogView.view,
		viewInputs: {
			className: "sm:max-w-lg",
			side: "right",
			hasTrigger: false,
			hasDescription: action !== null,
			toView: ({ portal }) => portal,
			toContent: () =>
				action === null
					? [
							DialogView.dialogHeader(h, "sheet", [
								DialogView.dialogTitle(h, "sheet", dialogId, "Proposed action", "sr-only"),
							]),
						]
					: actionSheetContent(h, dialogId, action, investigation.report, trigger),
		},
		toParentMessage: (message) => Message.GotActionSheetMessage({ message }),
	})
}
