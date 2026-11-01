import type { SecurityAuditFinding, SecurityAuditRunDetail } from "@maple/domain/http"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { linkButton } from "../../../ui/button"
import * as DialogView from "../../../ui/dialog-view"
import { badge } from "../../../ui/display"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { panel, panelHeader } from "../../../ui/panel"
import { findingBody } from "../kit/finding-body"
import { bucketOf, countByBucket, sectionsOf, type SeverityBucket } from "../kit/findings"
import { findingBadge, findingGroups, severityTabs, trailingText } from "../kit/findings-view"
import { FINDING_STATUS_LABEL, gateOf, isLive, locationOf } from "../kit/format"
import { gateState, placeholderRows } from "../kit/parts"
import { countOf, openFindingOf } from "./derive"
import { Message, type Model } from "./model"
import { emptyMessage } from "../../../ui/empty"

// What the run reported, first on the page: severity tabs over severity groups, each finding
// opening in a side sheet.

type H = HtmlBuilder<Message>

/** New to this run, or carried from an earlier one; a triaged finding shows its triage. */
const seenOf = (h: H, finding: SecurityAuditFinding, runId: string): Html =>
	finding.status !== "open"
		? badge(h, { variant: "meta" }, [FINDING_STATUS_LABEL[finding.status]])
		: finding.firstSeenRunId === runId
			? badge(h, { variant: "done" }, ["New"])
			: trailingText(h, "Seen before")

const CONFIDENCE_LABEL = { low: "low confidence", medium: "medium confidence", high: "" } as const

/** Only a doubt is worth a word: high confidence is the norm and stays quiet. */
const confidenceOf = (h: H, finding: SecurityAuditFinding): ReadonlyArray<Html> =>
	finding.record.verdict === "confirmed" && finding.record.confidence.score !== "high"
		? [trailingText(h, CONFIDENCE_LABEL[finding.record.confidence.score], "hidden sm:inline")]
		: []

const reportLinks = (h: H, run: SecurityAuditRunDetail): ReadonlyArray<Html> =>
	run.reports === null
		? []
		: [
				h.div(
					[h.Class("flex flex-wrap items-center gap-3 px-4 py-2.5 text-xs")],
					[
						h.span([h.Class("text-muted-foreground")], ["Reports:"]),
						...(
							[
								["report", "REPORT.md"],
								["findingsDetail", "FINDINGS-DETAIL.md"],
								["needsValidation", "NEEDS-VALIDATION.md"],
							] as const
						).map(([report, label]) =>
							h.button(
								[
									h.Key(report),
									h.Type("button"),
									h.Class(
										"font-mono underline underline-offset-2 hover:text-foreground active:text-foreground",
									),
									h.OnClick(Message.ClickedReport({ report })),
								],
								[label],
							),
						),
					],
				),
			]

const emptyLine = (h: H, run: SecurityAuditRunDetail): Html => {
	const waiting = countOf(run, "candidate")
	return emptyMessage(h, {}, [
		isLive(run)
			? waiting > 0
				? `Nothing verified yet. ${waiting} ${waiting === 1 ? "candidate is" : "candidates are"} waiting for a second model.`
				: "Nothing reported yet. Findings appear here as they are verified."
			: "This run reported no findings.",
	])
}

const findingsList = (h: H, model: Model, findings: ReadonlyArray<SecurityAuditFinding>): Html => {
	// A disproved finding stays in reach under any tab, in its folded group.
	const shown =
		model.severity === null
			? findings
			: findings.filter(
					(finding) => finding.verdict === "rejected" || bucketOf(finding) === model.severity,
				)
	return findingGroups(h, {
		sections: sectionsOf(shown),
		collapsed: model.collapsed,
		onToggle: (bucket) => Message.ToggledSection({ bucket }),
		label: "Findings of this run",
		row: (finding) => ({
			finding,
			open: { onClick: Message.ClickedFinding({ fingerprint: finding.fingerprint }) },
			trailing: [...confidenceOf(h, finding), seenOf(h, finding, model.runId)],
		}),
	})
}

/** One panel: severity tabs in its header row, the groups, then the report links. */
export const findingsSection = (h: H, model: Model, run: SecurityAuditRunDetail): ReadonlyArray<Html> =>
	AsyncData.matchData(model.findings.data, {
		onEmpty: () => [
			panel(h, { className: "min-w-0 overflow-hidden" }, [
				panelHeader(h, { title: "Findings" }),
				placeholderRows(h, 4),
			]),
		],
		onFailure: (failure) => {
			const gate = gateOf(failure)
			return [
				gate === null
					? errorState(h, {
							failure,
							title: "Couldn't load this run's findings",
							onRetry: Message.ClickedRetry(),
						})
					: gateState(h, gate),
			]
		},
		onData: ({ findings }) => {
			const counts = countByBucket(findings)
			return [
				panel(h, { className: "min-w-0 overflow-hidden" }, [
					h.div(
						[h.Class("flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2")],
						[
							h.span([h.Class("text-sm font-medium")], ["Findings"]),
							...(findings.length === 0
								? []
								: [
										severityTabs(h, {
											counts,
											active: model.severity,
											onPick: (bucket: SeverityBucket | null) =>
												Message.PickedSeverity({ bucket }),
											label: "Severity",
										}),
									]),
							...(counts.rejected === 0
								? []
								: [trailingText(h, `${counts.rejected} disproved`, "ml-auto")]),
						],
					),
					findings.length === 0 ? emptyLine(h, run) : findingsList(h, model, findings),
					...reportLinks(h, run),
				]),
			]
		},
	})

/** The open finding's record in a side sheet, with the way to its own page for triage. */
export const findingSheet = (h: H, model: Model): Html => {
	const finding = openFindingOf(model)
	const id = model.findingDialog.id
	return h.submodel({
		slotId: id,
		model: model.findingDialog,
		view: DialogView.view,
		viewInputs: {
			hasTrigger: false,
			side: "right",
			className: "sm:max-w-3xl",
			toView: ({ portal }) => portal ?? h.empty,
			toContent: () =>
				finding === null
					? []
					: [
							DialogView.dialogHeader(h, "sheet", [
								h.div(
									[h.Class("flex flex-wrap items-center gap-2")],
									[
										findingBadge(h, finding),
										h.span(
											[h.Class("font-mono text-xs text-muted-foreground")],
											[locationOf(finding.record) ?? ""],
										),
									],
								),
								DialogView.dialogTitle(h, "sheet", id, finding.record.title),
								h.div(
									[h.Class("pt-1")],
									[
										linkButton(
											h,
											{
												size: "sm",
												variant: "outline",
												href: hrefOf(
													AppRoute.SecurityFinding({
														targetId: finding.targetId,
														fingerprint: finding.fingerprint,
													}),
												),
											},
											["Open finding page", icon(h, "ArrowRightIcon")],
										),
									],
								),
							]),
							DialogView.dialogPanel(h, "sheet", id, [
								h.div([h.Class("flex flex-col gap-4")], findingBody(h, finding)),
							]),
						],
		},
		toParentMessage: (message) => Message.GotFindingDialogMessage({ message }),
	})
}
