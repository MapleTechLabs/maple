import type { SecurityAuditFinding, SecurityAuditTarget } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import type { SecurityFindingsSearch } from "../../../route/search"
import { badge } from "../../../ui/display"
import { errorState } from "../../../ui/error-state"
import { searchInput } from "../../../ui/search-input"
import * as SelectView from "../../../ui/select-view"
import * as Select from "../../../ui/select"
import { switchControl } from "../../../ui/switch"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { nothingInWindow } from "../../kit/nothing-in-window"
import { relativeTime } from "../../kit/relative-time"
import { countByBucket, sectionsOf } from "../kit/findings"
import { confidenceText, SECTION_HINT, sectionHeaderRow, severityTiles } from "../kit/findings-view"
import { FINDING_STATUS_LABEL, locationOf, STATUS_TAB_LABEL } from "../kit/format"
import { gateState, placeholderRows, repositoryName } from "../kit/parts"
import {
	countForTab,
	filteredFindings,
	findingsStateOf,
	isNewFinding,
	isReopened,
	STATUS_TABS,
	statusTabOf,
	targetsOf,
	toolbarFindings,
} from "./derive"
import { Message, type Model } from "./model"

// The Findings tab: status tabs, severity tiles, the toolbar, then findings in severity sections.

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const statusTabs = (h: H, model: Model, findings: ReadonlyArray<SecurityAuditFinding>): Html => {
	const active = statusTabOf(model.findingsSearch)
	return h.nav(
		[h.AriaLabel("Finding status"), h.Class("flex items-center gap-1 overflow-x-auto")],
		STATUS_TABS.map((tab) => {
			// The search box as typed, so a status switch within the debounce keeps the query.
			const { status: _status, q: _q, ...filters } = model.findingsSearch
			const q = model.searchDraft.trim()
			const rest: SecurityFindingsSearch = q === "" ? filters : { ...filters, q }
			const search: SecurityFindingsSearch = tab === "open" ? rest : { ...rest, status: tab }
			const isActive = tab === active
			return h.a(
				[
					h.Key(tab),
					h.Href(hrefOf(AppRoute.SecurityFindings({ search }))),
					...(isActive ? [h.AriaCurrent("page")] : []),
					h.Class(
						cn(
							"flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors",
							isActive
								? "bg-muted font-medium text-foreground"
								: "text-muted-foreground hover:text-foreground",
						),
					),
				],
				[
					STATUS_TAB_LABEL[tab],
					h.span(
						[h.Class("font-mono tabular-nums text-muted-foreground")],
						[String(countForTab(findings, tab))],
					),
				],
			)
		}),
	)
}

const selectSubmodel = (
	h: H,
	select: Select.Model,
	entries: ReadonlyArray<SelectView.SelectEntry>,
	label: string,
	renderValue: (value: string) => string,
	wrap: (message: Select.Message) => Message,
): Html =>
	h.submodel({
		slotId: select.id,
		model: select,
		view: SelectView.view,
		viewInputs: {
			entries,
			size: "sm",
			ariaLabel: label,
			className: "h-7 w-auto min-w-28 text-xs",
			renderValue: (value) => [
				h.span([h.Class("text-muted-foreground")], [`${label} `]),
				renderValue(value),
			],
			toView: (parts) => h.div([h.Class("contents")], parts),
		},
		toParentMessage: (message) => wrap(message),
	})

const item = (value: string, label: string): SelectView.SelectEntry => ({
	_tag: "Item",
	item: { value, label },
})

const toolbar = (h: H, model: Model, targets: ReadonlyArray<SecurityAuditTarget>, count: number): Html => {
	const targetLabel = (value: string) =>
		value === "all"
			? "All targets"
			: (targets.find((target) => target.id === value)?.repository ?? "Removed target")
	return h.div(
		[h.Class("flex flex-wrap items-center gap-2 border-b border-border/60 px-2 py-1.5")],
		[
			searchInput(h, {
				id: "security-findings-search",
				size: "sm",
				className: "w-72 max-w-sm",
				placeholder: "Search title, file or fingerprint",
				value: model.searchDraft,
				onInput: (value) => Message.ChangedSearchDraft({ value }),
				onClear: Message.ChangedSearchDraft({ value: "" }),
			}),
			// One repository needs no target filter.
			...(targets.length < 2
				? []
				: [
						selectSubmodel(
							h,
							model.targetSelect,
							[
								item("all", "All targets"),
								...targets.map((target) => item(target.id, target.repository)),
							],
							"Target",
							targetLabel,
							(message) => Message.GotTargetSelectMessage({ message }),
						),
					]),
			h.label(
				[
					h.Id("security-show-rejected-label"),
					h.Class("ml-auto flex items-center gap-2 text-xs text-muted-foreground"),
				],
				[
					...switchControl(h, {
						id: "security-show-rejected",
						inputId: "security-show-rejected-input",
						isChecked: model.findingsSearch.rejected === true,
						labelledBy: "security-show-rejected-label",
						onToggle: Message.ToggledShowRejected(),
					}),
					"Show rejected",
				],
			),
			h.span(
				[h.Class("text-xs tabular-nums text-muted-foreground")],
				[`${count} ${count === 1 ? "finding" : "findings"}`],
			),
		],
	)
}

/** Reopened and new lead; otherwise the triage status, quiet while it is the usual "Open". */
const statusCell = (h: H, finding: SecurityAuditFinding, nowMs: number): Html =>
	isReopened(finding)
		? badge(h, { variant: "meta" }, ["Reopened"])
		: isNewFinding(finding, nowMs)
			? badge(h, { variant: "done" }, ["New"])
			: h.span(
					[
						h.Class(
							cn(
								"text-xs",
								finding.status === "open" ? "text-muted-foreground" : "text-foreground",
							),
						),
					],
					[FINDING_STATUS_LABEL[finding.status]],
				)

/** The location, led by why a lead is unproven or a claim was disproved. */
const subline = (finding: SecurityAuditFinding): string => {
	const { record } = finding
	const lead =
		record.verdict === "needs_validation"
			? (record.blockers[0] ?? null)
			: record.verdict === "rejected"
				? `rejected: ${record.reason}`
				: null
	return [locationOf(record), lead].filter((part) => part !== null).join(" · ")
}

const findingRow = (
	h: H,
	finding: SecurityAuditFinding,
	targets: ReadonlyArray<SecurityAuditTarget>,
	clock: Clock,
	hasTargetColumn: boolean,
): Html => {
	const href = hrefOf(
		AppRoute.SecurityFinding({ targetId: finding.targetId, fingerprint: finding.fingerprint }),
	)
	const repository =
		targets.find((target) => target.id === finding.targetId)?.repository ?? "Removed target"
	return tableRow(
		h,
		[
			tableCell(
				h,
				[
					h.a(
						[h.Href(href), h.Class("flex min-w-0 flex-col gap-0.5 after:absolute after:inset-0")],
						[
							h.span(
								[
									h.Class(
										cn(
											"truncate text-sm",
											finding.verdict === "rejected" &&
												"text-muted-foreground line-through",
										),
									),
								],
								[finding.record.title],
							),
							h.span(
								[h.Class("truncate font-mono text-xs text-muted-foreground")],
								[subline(finding)],
							),
						],
					),
				],
				"w-full max-w-0 pl-11",
			),
			tableCell(h, [confidenceText(h, finding)], "hidden w-24 md:table-cell"),
			...(hasTargetColumn
				? [tableCell(h, [repositoryName(h, repository, "text-sm")], "hidden w-56 lg:table-cell")]
				: []),
			tableCell(h, [statusCell(h, finding, clock.nowMs)], "w-28"),
			tableCell(
				h,
				[
					relativeTime(h, {
						value: finding.updatedAt,
						nowMs: clock.nowMs,
						timeZone: clock.timeZone,
						variant: "short",
						tooltip: "title",
					}),
				],
				"w-24 text-right font-mono text-xs text-muted-foreground",
			),
		],
		"relative",
		[h.Key(`${finding.targetId}/${finding.fingerprint}`)],
	)
}

const findingsTable = (
	h: H,
	model: Model,
	rows: ReadonlyArray<SecurityAuditFinding>,
	targets: ReadonlyArray<SecurityAuditTarget>,
	clock: Clock,
): Html => {
	const hasTargetColumn = targets.length > 1 && model.findingsSearch.target === undefined
	const columns = hasTargetColumn ? 5 : 4
	return table(h, { variant: "bare", ariaLabel: "Findings" }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, ["Finding"], "pl-11"),
				tableHead(h, ["Confidence"], "hidden md:table-cell"),
				...(hasTargetColumn ? [tableHead(h, ["Target"], "hidden lg:table-cell")] : []),
				tableHead(h, ["Status"]),
				tableHead(h, ["Last seen"], "text-right"),
			]),
		]),
		tableBody(
			h,
			sectionsOf(rows).flatMap(({ bucket, rows: sectionRows }) => {
				const isCollapsed = model.collapsed.includes(bucket)
				return [
					sectionHeaderRow(h, {
						bucket,
						count: sectionRows.length,
						isCollapsed,
						onToggle: Message.ToggledSection({ bucket }),
						colSpan: columns,
						hint: SECTION_HINT[bucket],
					}),
					...(isCollapsed
						? []
						: sectionRows.map((finding) =>
								findingRow(h, finding, targets, clock, hasTargetColumn),
							)),
				]
			}),
		),
	])
}

/** The tab's one-line explanation above the list. The gate and the failure card go without it,
 * so the failure lines up with the other Security tabs. */
const findingsIntro = (h: H): Html =>
	h.p(
		[h.Class("-mb-3 font-prose text-xs text-muted-foreground")],
		["Each finding is tracked by its fingerprint from run to run."],
	)

export const findingsBody = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> => {
	const clock: Clock = { nowMs: model.nowMs, timeZone }
	const state = findingsStateOf(model)
	if (state._tag === "Gated") return [gateState(h, state.gate)]
	if (state._tag === "Failed")
		return [
			errorState(h, {
				failure: state.failure,
				title: "Couldn't load findings",
				onRetry: Message.ClickedRetry(),
			}),
		]
	const targets = targetsOf(model)
	const all = state._tag === "Ready" ? state.findings : []
	const query = model.findingsSearch.q ?? ""
	const rows = filteredFindings(all, model.findingsSearch, query)
	const content =
		state._tag === "Loading"
			? placeholderRows(h, 6)
			: targets.length === 0
				? nothingInWindow(h, {
						title: "No findings yet",
						description: "Findings appear here after the first audit run of a target finishes.",
					})
				: rows.length === 0
					? h.div(
							[h.Class("p-4")],
							[
								nothingInWindow(h, {
									title: "No findings match",
									description:
										all.length === 0
											? "No audit has reported a finding yet."
											: "Nothing in this status matches the filters.",
									onClear:
										// Clearing keeps the status tab, so the status alone is not a filter.
										Object.keys(model.findingsSearch).some((key) => key !== "status")
											? Message.ClickedClearFilters()
											: undefined,
								}),
							],
						)
					: findingsTable(h, model, rows, targets, clock)
	return [
		findingsIntro(h),
		...(targets.length === 0 || state._tag !== "Ready"
			? []
			: [
					severityTiles(h, {
						counts: countByBucket(toolbarFindings(all, model.findingsSearch, query)),
						active: model.findingsSearch.severity ?? null,
						onPick: (bucket) => Message.PickedSeverity({ bucket }),
						label: "Findings by severity",
					}),
				]),
		h.section(
			[h.AriaLabel("Findings"), h.Class("overflow-hidden rounded-md border bg-card")],
			[
				// Nothing to filter until there is a target, as the errors hub hides its toolbar when empty.
				...(targets.length === 0
					? []
					: [
							h.div(
								[h.Class("border-b border-border/60 px-2 py-1.5")],
								[statusTabs(h, model, all)],
							),
							toolbar(
								h,
								model,
								targets,
								rows.filter((finding) => finding.verdict !== "rejected").length,
							),
						]),
				content,
			],
		),
	]
}
