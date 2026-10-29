import type { SecurityAuditFinding, SecurityAuditTarget } from "@maple/domain/http"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { badge } from "../../../ui/display"
import { errorState } from "../../../ui/error-state"
import { searchInput } from "../../../ui/search-input"
import * as SelectView from "../../../ui/select-view"
import * as Select from "../../../ui/select"
import { switchControl } from "../../../ui/switch"
import { nothingInWindow } from "../../kit/nothing-in-window"
import { relativeTime } from "../../kit/relative-time"
import { countByBucket, sectionsOf, type SeverityBucket } from "../kit/findings"
import { findingGroups, severityTabs, trailingText } from "../kit/findings-view"
import { FINDING_STATUS_LABEL, STATUS_TAB_LABEL } from "../kit/format"
import { gateState, placeholderRows, repositoryName } from "../kit/parts"
import {
	countForTab,
	filteredFindings,
	findingsStateOf,
	isNewFinding,
	isReopened,
	STATUS_TABS,
	targetsOf,
	toolbarFindings,
} from "./derive"
import { Message, type Model } from "./model"

// The Findings tab, as Linear lists issues: severity tabs, a filter toolbar, then one dense line
// per finding under collapsible severity groups.

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

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

const toolbar = (
	h: H,
	model: Model,
	findings: ReadonlyArray<SecurityAuditFinding>,
	targets: ReadonlyArray<SecurityAuditTarget>,
): Html => {
	const targetLabel = (value: string) =>
		value === "all"
			? "All targets"
			: (targets.find((target) => target.id === value)?.repository ?? "Removed target")
	const statusLabel = (value: string) => STATUS_TABS.find((tab) => tab === value) ?? "open"
	return h.div(
		[h.Class("flex flex-wrap items-center gap-2 border-b px-3 py-2")],
		[
			searchInput(h, {
				id: "security-findings-search",
				size: "sm",
				className: "w-64 max-w-sm",
				placeholder: "Search title, file or fingerprint",
				value: model.searchDraft,
				onInput: (value) => Message.ChangedSearchDraft({ value }),
				onClear: Message.ChangedSearchDraft({ value: "" }),
			}),
			selectSubmodel(
				h,
				model.statusSelect,
				STATUS_TABS.map((tab) =>
					item(tab, `${STATUS_TAB_LABEL[tab]} (${countForTab(findings, tab)})`),
				),
				"Status",
				(value) => STATUS_TAB_LABEL[statusLabel(value)],
				(message) => Message.GotStatusSelectMessage({ message }),
			),
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
		],
	)
}

/** Reopened and new lead; a triaged finding says how; an open one says nothing. */
const statusOf = (h: H, finding: SecurityAuditFinding, nowMs: number): ReadonlyArray<Html> =>
	isReopened(finding)
		? [badge(h, { variant: "meta" }, ["Reopened"])]
		: isNewFinding(finding, nowMs)
			? [badge(h, { variant: "done" }, ["New"])]
			: finding.status === "open"
				? []
				: [badge(h, { variant: "meta" }, [FINDING_STATUS_LABEL[finding.status]])]

const findingsList = (
	h: H,
	model: Model,
	rows: ReadonlyArray<SecurityAuditFinding>,
	targets: ReadonlyArray<SecurityAuditTarget>,
	clock: Clock,
): Html => {
	const showsTarget = targets.length > 1 && model.findingsSearch.target === undefined
	return findingGroups(h, {
		sections: sectionsOf(rows),
		collapsed: model.collapsed,
		onToggle: (bucket) => Message.ToggledSection({ bucket }),
		label: "Findings",
		row: (finding) => ({
			finding,
			open: {
				href: hrefOf(
					AppRoute.SecurityFinding({
						targetId: finding.targetId,
						fingerprint: finding.fingerprint,
					}),
				),
			},
			trailing: [
				...statusOf(h, finding, clock.nowMs),
				...(showsTarget
					? [
							repositoryName(
								h,
								targets.find((target) => target.id === finding.targetId)?.repository ??
									"Removed target",
								"hidden max-w-48 text-xs lg:inline",
							),
						]
					: []),
				h.span(
					[h.Class("w-8 text-right font-mono text-xs text-muted-foreground")],
					[
						relativeTime(h, {
							value: finding.updatedAt,
							nowMs: clock.nowMs,
							timeZone: clock.timeZone,
							variant: "short",
							tooltip: "title",
						}),
					],
				),
			],
		}),
	})
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
										// Clearing keeps the status, so the status alone is not a filter.
										Object.keys(model.findingsSearch).some((key) => key !== "status")
											? Message.ClickedClearFilters()
											: undefined,
								}),
							],
						)
					: findingsList(h, model, rows, targets, clock)
	const shown = rows.filter((finding) => finding.verdict !== "rejected").length
	return [
		findingsIntro(h),
		h.section(
			[h.AriaLabel("Findings"), h.Class("overflow-hidden rounded-md border bg-card")],
			[
				// Nothing to filter until there is a target, as the errors hub hides its toolbar when empty.
				...(targets.length === 0 || state._tag !== "Ready"
					? []
					: [
							h.div(
								[h.Class("flex items-center gap-3 border-b px-3 py-2")],
								[
									severityTabs(h, {
										counts: countByBucket(
											toolbarFindings(all, model.findingsSearch, query),
										),
										active: model.findingsSearch.severity ?? null,
										onPick: (bucket: SeverityBucket | null) =>
											Message.PickedSeverity({ bucket }),
										label: "Severity",
									}),
									trailingText(
										h,
										`${shown} ${shown === 1 ? "finding" : "findings"}`,
										"ml-auto shrink-0 tabular-nums",
									),
								],
							),
							toolbar(h, model, all, targets),
						]),
				content,
			],
		),
	]
}
