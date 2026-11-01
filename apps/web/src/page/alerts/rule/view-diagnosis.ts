import type {
	AlertCheckDocument,
	AlertDeliveryEventDocument,
	AlertDestinationDocument,
	AlertIncidentDocument,
	AlertRuleDocument,
} from "@maple/domain/http"
import { countLabel, pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import {
	buildDiagnosis,
	type DiagnosisStage,
	type DiagnosisStageStatus,
	diagnosisVerdict,
} from "@maple/web-data/alerts/diagnosis"
import { worstState } from "@maple/web-data/alerts/rule-status"
import type { AlertRuleStateRow } from "@maple/web-data/collections/alerts"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "../../../ui/button"
import { card } from "../../../ui/card"
import { icon } from "../../../ui/icon"
import { segmentedSelect } from "../../../ui/segmented-select"
import { alertsHref } from "../shared/links"
import { Message } from "./message"
import type { Model } from "./model"

// `RuleDiagnosisPanel`: the rule's diagnosis.

type H = HtmlBuilder<Message>

const STATUS_CLASS = new Map<DiagnosisStageStatus, string>([
	["pass", "text-severity-info"],
	["warn", "text-severity-warn"],
	["fail", "text-severity-error"],
	["unknown", "text-muted-foreground"],
])
const EVIDENCE_CAP = 4

const stageIcon = (h: H, status: DiagnosisStageStatus, size: number): Html =>
	icon(h, status === "pass" ? "CheckIcon" : "CircleWarningIcon", {
		size,
		className: cn("shrink-0", STATUS_CLASS.get(status)),
	})

export type DiagnosisInputs = Readonly<{
	rule: AlertRuleDocument
	states: ReadonlyArray<AlertRuleStateRow>
	checks: ReadonlyArray<AlertCheckDocument>
	openIncidents: ReadonlyArray<AlertIncidentDocument>
	destinations: ReadonlyArray<AlertDestinationDocument>
	deliveryEvents: ReadonlyArray<AlertDeliveryEventDocument>
	now: number
	timeZone: string
}>

export const diagnosisPanel = (h: H, model: Model, inputs: DiagnosisInputs): Html => {
	const keys = [...new Set(inputs.states.map((s) => s.group_key))].sort()
	const groupKeys = keys.length > 1 ? keys : []
	const activeGroup = model.selectedGroup ?? worstState(inputs.states)?.group_key ?? null
	const stages = buildDiagnosis({
		rule: inputs.rule,
		states: inputs.states,
		checks: inputs.checks,
		openIncidents: inputs.openIncidents,
		destinations: inputs.destinations,
		deliveryEvents: inputs.deliveryEvents,
		now: inputs.now,
		timeZone: inputs.timeZone,
		...(groupKeys.length > 0 && activeGroup != null ? { selectedGroupKey: activeGroup } : undefined),
	})
	const verdict = diagnosisVerdict(stages)
	const hasProblems = verdict.status !== "pass"
	const isOpen = model.isDiagnosisExpanded ?? hasProblems
	const problemStages = stages.filter((s) => s.status === "fail" || s.status === "warn")
	const hasHiddenSteps = hasProblems && problemStages.length < stages.length
	const visibleStages = model.isShowingAllStages || !hasProblems ? stages : problemStages
	const passingCount = stages.filter((s) => s.status === "pass").length
	const hiddenCount = stages.length - problemStages.length

	return card(
		h,
		[
			h.button(
				[
					h.Type("button"),
					h.Class("flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left"),
					h.OnClick(Message.ClickedDiagnosisHeader({ isOpen })),
				],
				[
					h.div(
						[h.Class("flex min-w-0 items-center gap-2.5")],
						[
							stageIcon(h, verdict.status, 16),
							h.div(
								[h.Class("min-w-0")],
								[
									h.p(
										[h.Class("text-sm font-medium")],
										[verdict.status === "pass" ? "Rule is healthy" : "Why is this alert failing?"],
									),
									h.p([h.Class("truncate text-xs text-muted-foreground")], [verdict.summary]),
								],
							),
						],
					),
					icon(h, "ChevronDownIcon", {
						size: 16,
						className: cn("shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-180"),
					}),
				],
			),
			...(isOpen
				? [
						h.div(
							[h.Class("border-t px-4 py-2.5")],
							[
								...(groupKeys.length > 0
									? [
											h.div(
												[h.Class("mb-3 flex items-center gap-2")],
												[
													h.span([h.Class("shrink-0 text-xs text-muted-foreground")], ["Group"]),
													h.div(
														[h.Class("-my-1 min-w-0 flex-1 overflow-x-auto py-1")],
														[
															segmentedSelect(h, {
																className: "w-max",
																value: activeGroup ?? groupKeys[0] ?? "",
																onChange: (value) => Message.ClickedDiagnosisGroup({ groupKey: value }),
																options: groupKeys.slice(0, 8).map((key) => ({ value: key, label: key })),
															}),
														],
													),
												],
											),
										]
									: []),
								h.ol([h.Class("space-y-1")], visibleStages.map((stage) => stageRow(h, model, stage))),
								...(hasHiddenSteps
									? [
											button(
												h,
												{
													variant: "link",
													size: "xs",
													className: "mt-1.5 text-muted-foreground hover:text-foreground active:text-foreground",
													attributes: [h.OnClick(Message.ClickedShowAllStages())],
												},
												[
													icon(h, "ChevronDownIcon", {
														className: cn("shrink-0 transition-transform", model.isShowingAllStages && "rotate-180"),
													}),
													model.isShowingAllStages
														? "Show only issues"
														: passingCount === hiddenCount
															? `${countLabel(passingCount, "check")} passing`
															: `Show ${hiddenCount} more ${pluralize(hiddenCount, "step")}`,
												],
											),
										]
									: []),
							],
						),
					]
				: []),
		],
		"overflow-hidden",
	)
}

const stageRow = (h: H, model: Model, stage: DiagnosisStage): Html => {
	const isProblematic = stage.status === "fail" || stage.status === "warn"
	const isOpen = model.stageOpen[stage.id] ?? isProblematic
	const showEvidence = isOpen && stage.evidence.length > 0
	const isEvidenceExpanded = model.stageEvidenceExpanded.includes(stage.id)
	const evidence = isEvidenceExpanded ? stage.evidence : stage.evidence.slice(0, EVIDENCE_CAP)
	const hiddenEvidence = stage.evidence.length - evidence.length
	return h.li(
		[
			h.Key(stage.id),
			h.Class(
				cn(
					"rounded-md px-2 py-1",
					stage.status === "fail" && "bg-severity-error-a1",
					stage.status === "warn" && "bg-severity-warn-a1",
				),
			),
		],
		[
			h.div(
				[h.Class("flex items-center gap-2.5")],
				[
					stageIcon(h, stage.status, 14),
					h.button(
						[
							h.Type("button"),
							h.Class("flex min-w-0 flex-1 items-baseline gap-2 text-left"),
							h.OnClick(Message.ClickedStage({ stageId: stage.id, isOpen: !isOpen })),
						],
						[
							h.span([h.Class("shrink-0 text-xs font-medium")], [stage.label]),
							h.span(
								[
									h.Class(
										cn("truncate text-xs", stage.status === "fail" ? "text-severity-error" : "text-muted-foreground"),
									),
								],
								[stage.summary],
							),
						],
					),
					...(stage.action != null ? stageAction(h, stage.action) : []),
				],
			),
			...(showEvidence
				? [
						h.ul(
							[h.Class("mt-1 space-y-0.5 pl-[26px]")],
							[
								...evidence.map((line) =>
									h.li([h.Key(line), h.Class("break-words text-xs text-muted-foreground")], [line]),
								),
								...(hiddenEvidence > 0
									? [
											h.li(
												[],
												[
													button(
														h,
														{
															variant: "link",
															size: "xs",
															className: "text-foreground-subtle hover:text-foreground active:text-foreground",
															attributes: [h.OnClick(Message.ClickedShowAllEvidence({ stageId: stage.id }))],
														},
														["+", String(hiddenEvidence), " more"],
													),
												],
											),
										]
									: []),
							],
						),
					]
				: []),
		],
	)
}

const stageAction = (h: H, action: NonNullable<DiagnosisStage["action"]>): ReadonlyArray<Html> => {
	if (action.kind === "enable")
		return [
			button(h, { variant: "outline", size: "xs", attributes: [h.OnClick(Message.ClickedToggleEnabled())] }, [
				action.label,
			]),
		]
	if (action.kind === "destinations")
		return [linkButton(h, { variant: "outline", size: "xs", href: alertsHref({ tab: "routing" }) }, [action.label])]
	return []
}
