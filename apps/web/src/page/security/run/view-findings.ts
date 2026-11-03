import type { SecurityAuditFinding, SecurityAuditRunDetail } from "@maple/domain/http"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { linkButton } from "@maple/views/ui/button"
import * as DialogView from "@maple/views/ui/dialog-view"
import { badge } from "@maple/views/ui/display"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { textLink } from "@maple/views/ui/text-link"
import { findingBody } from "../kit/finding-body"
import { bucketOf, countByBucket, sectionsOf, type SeverityBucket } from "../kit/findings"
import { findingBadge, findingGroups, severityTabs, trailingText } from "../kit/findings-view"
import { FINDING_STATUS_LABEL, gateOf, isLive, locationOf } from "../kit/format"
import { gateState, placeholderRows } from "../kit/parts"
import { countOf, openFindingOf } from "./derive"
import { Message, type Model } from "./model"
import { emptyMessage } from "@maple/views/ui/empty"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

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
						...Arr.map(
							[
								["report", "REPORT.md"],
								["findingsDetail", "FINDINGS-DETAIL.md"],
								["needsValidation", "NEEDS-VALIDATION.md"],
							] as const,
							([report, label]) =>
								textLink(
									h,
									{
										tone: "muted",
										isMono: true,
										className: "underline",
										onClick: Message.ClickedReport({ report }),
										attributes: [h.Key(report)],
									},
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
			: Arr.filter(
					findings,
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
							typography(h, { size: "sm", weight: "medium" }, ["Findings"]),
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
								hstack(h, { gap: "2", wrap: true }, [
									findingBadge(h, finding),
									typography(h, { size: "xs", tone: "muted", mono: true }, [
										locationOf(finding.record) ?? "",
									]),
								]),
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
								vstack(h, { gap: "4" }, findingBody(h, finding)),
							]),
						],
		},
		toParentMessage: (message) => Message.GotFindingDialogMessage({ message }),
	})
}
