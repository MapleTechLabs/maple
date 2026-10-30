import { countLabel, pluralize } from "@maple/ui/lib/format"
import { type AlertRulePreviewResponse, UNGROUPED_GROUP_KEY } from "@maple/domain/http"
import { breachStatsFromPreview, formatBreachDuration } from "@maple/web-data/alerts/breach-stats"
import { displaySignalType, formatSignalValue } from "@maple/web-data/alerts/form-utils"
import { diffRuleForms, incidentsClearedByDraft } from "@maple/web-data/alerts/preview-insights"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../../ui/eyebrow"
import { skeleton } from "../../../ui/skeleton"
import { previewIssue, previewStateOf } from "../shared/preview"
import { isoMs } from "../shared/time"
import { draftPreviewOf, openIncidentsOf, windowMsOf } from "./derive-rows"
import type { RuleForm } from "./form"
import type { Message } from "./message"
import type { Model } from "./model"
import { isEvaluationChanged } from "./plan"

// `RuleEditImpact`: the saved rule and the draft replayed
// over one window, every changed field, and the open incidents the draft would clear.

type H = HtmlBuilder<Message>

const figure = (
	h: H,
	before: string,
	after: string,
	caption: string,
	tone: "good" | "warn" | "neutral",
): Html =>
	h.div(
		[],
		[
			h.p(
				[h.Class("flex items-baseline gap-2 text-2xl font-semibold tabular-nums")],
				[
					h.span([h.Class("text-muted-foreground line-through decoration-1")], [before]),
					h.span(
						[
							h.Class(
								cn(
									tone === "good" && "text-severity-info",
									tone === "warn" && "text-severity-warn",
								),
							),
						],
						[after],
					),
				],
			),
			h.p([h.Class("text-xs text-muted-foreground")], [caption]),
		],
	)

/** What the comparison block reads off the Model. */
export type ImpactView = Pick<
	Model,
	"savedForm" | "savedPreview" | "preview" | "previewWindow" | "incidents" | "editingRuleId"
>

/** The comparison block, once the draft differs from the saved rule (`comparison !== null`). */
export const editImpact = (h: H, model: ImpactView, form: RuleForm): Html => {
	const saved = model.savedForm
	if (saved === null) return null
	const changes = diffRuleForms(saved, form)
	if (changes.length === 0) return null
	const draft = draftPreviewOf(model, form)
	const isChanged = isEvaluationChanged({ savedForm: saved, form })
	const replay = isChanged
		? previewStateOf(model.savedPreview, true, previewIssue(saved))
		: { preview: draft.preview, isLoading: false, error: null }
	const cleared = isChanged ? incidentsClearedByDraft(openIncidentsOf(model), draft.preview) : []
	const before = breachStatsFromPreview(replay.preview)
	const after = breachStatsFromPreview(draft.preview)
	const delta = after.breachCount - before.breachCount
	const display = displaySignalType(form)
	const domain = windowMsOf(model)
	return h.div(
		[h.Class("space-y-3 border-b px-4 pt-3 pb-4")],
		[
			eyebrow(h, { variant: "label" }, [
				"Before and after · ",
				String(changes.length),
				" unsaved ",
				pluralize(changes.length, "change"),
			]),
			replay.isLoading || draft.isLoading
				? skeleton(h, "h-14 w-full")
				: h.div(
						[h.Class("flex flex-wrap gap-x-10 gap-y-3")],
						[
							figure(
								h,
								String(before.breachCount),
								countLabel(after.breachCount, "alert"),
								delta === 0
									? "Same number of alerts in this window"
									: `${Math.abs(delta)} ${delta < 0 ? "fewer" : "more"} than the saved rule`,
								delta < 0 ? "good" : delta > 0 ? "warn" : "neutral",
							),
							figure(
								h,
								formatBreachDuration(before.longestRunMs),
								formatBreachDuration(after.longestRunMs),
								"longest time firing",
								"neutral",
							),
						],
					),
			h.div(
				[h.Class("space-y-1")],
				[
					fireRail(h, "before", replay.preview, domain, "muted"),
					fireRail(h, "after", draft.preview, domain, "crit"),
				],
			),
			h.ul(
				[h.Class("flex flex-wrap gap-1.5 text-xs")],
				changes.map((change) =>
					h.li(
						[h.Key(change.field), h.Class("rounded-sm border bg-muted/30 px-2 py-1")],
						[
							h.span([h.Class("text-muted-foreground")], [change.field, " "]),
							h.span(
								[h.Class("font-mono text-muted-foreground line-through")],
								[change.before],
							),
							h.span([h.Class("text-muted-foreground")], [" → "]),
							h.span([h.Class("font-mono")], [change.after]),
						],
					),
				),
			),
			...clearedBlock(h, cleared, display),
		],
	)
}

const clearedBlock = (
	h: H,
	cleared: ReturnType<typeof incidentsClearedByDraft>,
	display: ReturnType<typeof displaySignalType>,
): ReadonlyArray<Html> =>
	cleared.length === 0
		? []
		: [
				h.div(
					[h.Class("border-l-2 border-severity-warn py-0.5 pl-3 text-xs")],
					[
						h.p(
							[h.Class("text-foreground")],
							[
								String(cleared.length),
								" open",
								" ",
								pluralize(cleared.length, "incident"),
								" would clear under this edit",
							],
						),
						h.ul(
							[h.Class("mt-0.5 text-muted-foreground")],
							[
								...cleared
									.slice(0, 3)
									.map((incident) =>
										h.li(
											[h.Key(incident.id)],
											[
												incident.groupKey === null ||
												incident.groupKey === UNGROUPED_GROUP_KEY
													? incident.ruleName
													: incident.groupKey,
												...(incident.lastObservedValue === null
													? []
													: [
															` at ${formatSignalValue(display, incident.lastObservedValue)}`,
														]),
											],
										),
									),
								...(cleared.length > 3
									? [h.li([], ["and ", String(cleared.length - 3), " more"])]
									: []),
							],
						),
						h.p(
							[h.Class("mt-0.5 text-muted-foreground")],
							["Takes effect on the next check after saving."],
						),
					],
				),
			]

/** `FireRail`: would-fire marks across the window, placed by start time. */
const fireRail = (
	h: H,
	label: string,
	preview: AlertRulePreviewResponse | null,
	domain: { min: number; max: number },
	tone: "muted" | "crit",
): Html => {
	const span = Math.max(domain.max - domain.min, 1)
	const marks = (preview?.wouldFire ?? []).flatMap((fire) => {
		const start = isoMs(fire.start)
		const end = isoMs(fire.end)
		if (!Number.isFinite(start) || !Number.isFinite(end)) return []
		const left = Math.min(Math.max((start - domain.min) / span, 0), 1)
		const width = Math.max((end - start) / span, 0.004)
		return [{ key: `${fire.groupKey}:${fire.start}`, left, width: Math.min(width, 1 - left) }]
	})
	return h.div(
		[h.Class("grid grid-cols-[48px_minmax(0,1fr)] items-center gap-2")],
		[
			h.span([h.Class("text-right text-2xs text-muted-foreground")], [label]),
			h.div(
				[
					h.Class("relative h-2 rounded-sm bg-muted/50"),
					h.AriaLabel(`${label}: ${marks.length} alerts`),
				],
				marks.map((mark) =>
					h.span([
						h.Key(mark.key),
						h.Class(
							cn(
								"absolute inset-y-0 min-w-0.5 rounded-[1px]",
								tone === "crit" ? "bg-severity-error" : "bg-muted-foreground/60",
							),
						),
						h.Style({ left: `${mark.left * 100}%`, width: `${mark.width * 100}%` }),
					]),
				),
			),
		],
	)
}
