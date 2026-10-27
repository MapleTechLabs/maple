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
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { findingBody } from "../kit/finding-body"
import { bucketOf, countByBucket, sectionsOf, type SeverityBucket } from "../kit/findings"
import {
	bucketBadge,
	confidenceText,
	findingTitle,
	SECTION_HINT,
	sectionHeaderRow,
	severityTiles,
} from "../kit/findings-view"
import { FINDING_STATUS_LABEL, gateOf, isLive, locationOf } from "../kit/format"
import { gateState, placeholderRows } from "../kit/parts"
import { countOf, openFindingOf } from "./derive"
import { Message, type Model } from "./model"

// What the run reported, first on the page: severity tiles over severity sections, each finding
// opening in a side sheet.

type H = HtmlBuilder<Message>

const COLUMNS = 4

/** New to this run, or carried from an earlier one; a triaged finding shows its triage. */
const seenCell = (h: H, finding: SecurityAuditFinding, runId: string): Html =>
	finding.status !== "open"
		? badge(h, { variant: "meta" }, [FINDING_STATUS_LABEL[finding.status]])
		: finding.firstSeenRunId === runId
			? badge(h, { variant: "done" }, ["New"])
			: h.span([h.Class("text-xs text-muted-foreground")], ["Seen before"])

const findingRow = (h: H, finding: SecurityAuditFinding, runId: string): Html =>
	tableRow(
		h,
		[
			tableCell(
				h,
				[
					h.button(
						[
							h.Type("button"),
							h.Class(
								"block w-full min-w-0 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-ring",
							),
							h.AriaLabel(`Open ${finding.record.title}`),
						],
						[findingTitle(h, finding)],
					),
				],
				"w-full max-w-0 pl-11",
			),
			tableCell(h, [confidenceText(h, finding)], "hidden w-24 md:table-cell"),
			tableCell(h, [seenCell(h, finding, runId)], "w-28"),
			tableCell(
				h,
				[icon(h, "ChevronRightIcon", { size: 14, className: "text-muted-foreground" })],
				"w-8",
			),
		],
		"cursor-pointer",
		[h.Key(finding.fingerprint), h.OnClick(Message.ClickedFinding({ fingerprint: finding.fingerprint }))],
	)

const findingsTable = (h: H, model: Model, findings: ReadonlyArray<SecurityAuditFinding>): Html => {
	const shown =
		model.severity === null
			? findings
			: findings.filter(
					(finding) => finding.verdict === "rejected" || bucketOf(finding) === model.severity,
				)
	return table(h, { variant: "bare", ariaLabel: "Findings of this run" }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, ["Finding"], "pl-11"),
				tableHead(h, ["Confidence"], "hidden md:table-cell"),
				tableHead(h, ["In this run"]),
				tableHead(h, [h.span([h.Class("sr-only")], ["Open"])]),
			]),
		]),
		tableBody(
			h,
			sectionsOf(shown).flatMap(({ bucket, rows }) => {
				const isCollapsed = model.collapsed.includes(bucket)
				return [
					sectionHeaderRow(h, {
						bucket,
						count: rows.length,
						isCollapsed,
						onToggle: Message.ToggledSection({ bucket }),
						colSpan: COLUMNS,
						hint: SECTION_HINT[bucket],
					}),
					...(isCollapsed ? [] : rows.map((finding) => findingRow(h, finding, model.runId))),
				]
			}),
		),
	])
}

const reportLinks = (h: H, run: SecurityAuditRunDetail): ReadonlyArray<Html> =>
	run.reports === null
		? []
		: [
				h.div(
					[h.Class("flex flex-wrap items-center gap-3 border-t px-4 py-2.5 text-xs")],
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
									h.Class("font-mono underline underline-offset-2 hover:text-foreground"),
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
	return h.p(
		[h.Class("px-4 py-6 text-sm text-muted-foreground")],
		[
			isLive(run)
				? waiting > 0
					? `Nothing verified yet. ${waiting} ${waiting === 1 ? "candidate is" : "candidates are"} waiting for a second model.`
					: "Nothing reported yet. Findings appear here as they are verified."
				: "This run reported no findings.",
		],
	)
}

/** Tiles, then sections; the tiles are counted over everything the run reported. */
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
				...(findings.length === 0
					? []
					: [
							severityTiles(h, {
								counts,
								active: model.severity,
								onPick: (bucket: SeverityBucket) => Message.PickedSeverity({ bucket }),
								label: "Findings by severity",
							}),
						]),
				panel(h, { className: "min-w-0 overflow-hidden" }, [
					panelHeader(h, {
						title: "Findings",
						action: h.span(
							[h.Class("text-xs text-muted-foreground")],
							[
								[
									`${findings.length - counts.rejected} reported`,
									...(counts.rejected === 0 ? [] : [`${counts.rejected} disproved`]),
								].join(" · "),
							],
						),
					}),
					findings.length === 0 ? emptyLine(h, run) : findingsTable(h, model, findings),
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
										bucketBadge(h, bucketOf(finding)),
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
