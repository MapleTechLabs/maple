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
import {
	FINDING_STATUS_LABEL,
	locationOf,
	SECURITY_SEVERITY_LABEL,
	SECURITY_SEVERITY_ORDER,
	shortId,
	STATUS_TAB_LABEL,
	VERDICT_LABEL,
} from "../kit/format"
import { gateState, placeholderRows, repositoryName, severityMark } from "../kit/parts"
import {
	countForTab,
	filteredFindings,
	findingsStateOf,
	GROUP_PAGE,
	groupFindings,
	isNewFinding,
	isReopened,
	STATUS_TABS,
	statusTabOf,
	targetsOf,
} from "./derive"
import { type FindingGroup, Message, type Model } from "./model"

// The Findings tab: status tabs, the errors hub's toolbar, findings grouped by verdict.

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const GROUP_HINT = {
	confirmed: "Sorted by severity, then last seen",
	needs_validation: "No severity until proven. Each needs code execution, which audits cannot run yet.",
	rejected: "A second model disproved these. Kept for the record.",
} satisfies Record<FindingGroup, string>

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
	const severityLabel = (value: string) => {
		const severity = SECURITY_SEVERITY_ORDER.find((candidate) => candidate === value)
		return severity === undefined ? "All" : SECURITY_SEVERITY_LABEL[severity]
	}
	return h.div(
		[h.Class("flex flex-wrap items-center gap-2 border-b border-border/60 px-2 py-1.5")],
		[
			searchInput(h, {
				id: "security-findings-search",
				size: "sm",
				className: "w-60 max-w-sm",
				placeholder: "Search title, file or fingerprint",
				value: model.searchDraft,
				onInput: (value) => Message.ChangedSearchDraft({ value }),
				onClear: Message.ChangedSearchDraft({ value: "" }),
			}),
			selectSubmodel(
				h,
				model.severitySelect,
				[
					item("all", "All severities"),
					...SECURITY_SEVERITY_ORDER.map((severity) =>
						item(severity, SECURITY_SEVERITY_LABEL[severity]),
					),
				],
				"Severity",
				severityLabel,
				(message) => Message.GotSeveritySelectMessage({ message }),
			),
			selectSubmodel(
				h,
				model.verdictSelect,
				[
					item("all", "Confirmed, needs validation"),
					item("confirmed", "Confirmed"),
					item("needs_validation", "Needs validation"),
				],
				"Verdict",
				(value) =>
					value === "confirmed"
						? "Confirmed"
						: value === "needs_validation"
							? "Needs validation"
							: "Confirmed, needs validation",
				(message) => Message.GotVerdictSelectMessage({ message }),
			),
			selectSubmodel(
				h,
				model.targetSelect,
				[item("all", "All targets"), ...targets.map((target) => item(target.id, target.repository))],
				"Target",
				targetLabel,
				(message) => Message.GotTargetSelectMessage({ message }),
			),
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

const statusCell = (h: H, finding: SecurityAuditFinding, nowMs: number): Html =>
	isReopened(finding)
		? badge(h, { variant: "meta" }, ["Reopened"])
		: isNewFinding(finding, nowMs)
			? badge(h, { variant: "done" }, ["New"])
			: h.span([h.Class("text-sm")], [FINDING_STATUS_LABEL[finding.status]])

const subline = (finding: SecurityAuditFinding): string => {
	const { record } = finding
	const location = locationOf(record)
	const lead =
		record.verdict === "needs_validation"
			? record.blockers[0] === undefined
				? null
				: `blocker: ${record.blockers[0]}`
			: record.verdict === "rejected"
				? `rejected: ${record.reason}`
				: null
	return [lead, location].filter((part) => part !== null).join(" · ")
}

export const findingRow = (
	h: H,
	finding: SecurityAuditFinding,
	targets: ReadonlyArray<SecurityAuditTarget>,
	clock: Clock,
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
				[severityMark(h, finding.verdict === "confirmed" ? finding.overallSeverity : null)],
				"w-10",
			),
			tableCell(h, [
				h.a(
					[h.Href(href), h.Class("flex min-w-0 flex-col")],
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
						h.span([h.Class("truncate text-xs text-muted-foreground")], [subline(finding)]),
					],
				),
			]),
			tableCell(h, [repositoryName(h, repository, "text-sm")]),
			tableCell(h, [statusCell(h, finding, clock.nowMs)]),
			tableCell(
				h,
				[`run ${shortId(finding.firstSeenRunId)}`],
				"font-mono text-xs text-muted-foreground",
			),
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
				"text-right font-mono text-xs text-muted-foreground",
			),
		],
		undefined,
		[h.Key(`${finding.targetId}/${finding.fingerprint}`)],
	)
}

const groupBlock = (
	h: H,
	model: Model,
	group: FindingGroup,
	rows: ReadonlyArray<SecurityAuditFinding>,
	targets: ReadonlyArray<SecurityAuditTarget>,
	clock: Clock,
): ReadonlyArray<Html> => {
	const isExpanded = model.expanded.includes(group)
	const shown = isExpanded ? rows : rows.slice(0, GROUP_PAGE)
	const hidden = rows.length - shown.length
	return [
		tableRow(
			h,
			[
				tableCell(
					h,
					[
						h.div(
							[h.Class("flex flex-wrap items-baseline justify-between gap-2")],
							[
								h.span(
									[h.Class("text-sm font-medium")],
									[
										VERDICT_LABEL[group],
										h.span(
											[h.Class("ml-2 font-mono text-xs text-muted-foreground")],
											[String(rows.length)],
										),
									],
								),
								h.span([h.Class("text-xs text-muted-foreground")], [GROUP_HINT[group]]),
							],
						),
					],
					"bg-muted/40",
					[h.Attribute("colspan", "6")],
				),
			],
			undefined,
			[h.Key(`group-${group}`)],
		),
		...shown.map((finding) => findingRow(h, finding, targets, clock)),
		...(hidden === 0
			? []
			: [
					tableRow(
						h,
						[
							tableCell(h, []),
							tableCell(
								h,
								[
									h.button(
										[
											h.Type("button"),
											h.Class(
												"text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground",
											),
											h.OnClick(Message.ClickedShowAll({ group })),
										],
										[
											`Show ${hidden} more ${group === "confirmed" ? "confirmed" : group === "rejected" ? "rejected" : "needing validation"}`,
										],
									),
								],
								undefined,
								[h.Attribute("colspan", "5")],
							),
						],
						undefined,
						[h.Key(`more-${group}`)],
					),
				]),
	]
}

export const findingsBody = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> => {
	const clock: Clock = { nowMs: model.nowMs, timeZone }
	const state = findingsStateOf(model)
	if (state._tag === "Gated") return [gateState(h, state.gate)]
	if (state._tag === "Failed")
		return [
			errorState(h, {
				failure: state.failure,
				title: "Failed to load findings",
				onRetry: Message.ClickedRetry(),
			}),
		]
	const targets = targetsOf(model)
	const all = state._tag === "Ready" ? state.findings : []
	const rows = filteredFindings(all, model.findingsSearch, model.findingsSearch.q ?? "")
	const groups = groupFindings(rows)
	const content =
		state._tag === "Loading"
			? placeholderRows(h, 6)
			: targets.length === 0
				? nothingInWindow(h, {
						title: "No findings yet",
						description: "Findings appear here after the first audit run of a target finishes.",
					})
				: groups.length === 0
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
					: table(h, { variant: "bare", ariaLabel: "Findings" }, [
							tableHeader(h, [
								tableRow(h, [
									tableHead(h, [h.span([h.Class("sr-only")], ["Severity"])], "w-10"),
									tableHead(h, ["Finding"]),
									tableHead(h, ["Target"]),
									tableHead(h, ["Status"]),
									tableHead(h, ["First seen"]),
									tableHead(h, ["Last seen"], "text-right"),
								]),
							]),
							tableBody(
								h,
								groups.flatMap(({ group, rows: groupRows }) =>
									groupBlock(h, model, group, groupRows, targets, clock),
								),
							),
						])
	return [
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
