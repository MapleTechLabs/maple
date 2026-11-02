import type { AlertDestinationDocument, AlertIncidentDocument, AlertRuleDocument } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { formatSignalValue } from "@maple/web-data/alerts/form-utils"
import type { AlertsOverviewReady } from "@maple/web-data/alerts/overview"
import {
	type RibbonCell,
	ruleBucket,
	ruleConditionSummary,
	ruleHeadroom,
	ruleRibbon,
} from "@maple/web-data/alerts/overview-derive"
import { type DerivedRuleStatus, worstState } from "@maple/web-data/alerts/rule-status"
import { groupByTag, type TagGroup, UNTAGGED_KEY } from "@maple/web-data/alerts/tag-grouping"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription } from "../../../ui/alert"
import { button } from "../../../ui/button"
import { filterChip } from "../../../ui/filter-chip"
import * as Menu from "../../../ui/menu"
import type { MenuEntry } from "../../../ui/menu-view"
import { rowActionsMenu } from "../../../ui/row-actions-menu"
import { statusDot } from "../../../ui/status-dot"
import { ROW_LINK_LIFT, rowLink } from "../../../ui/table"
import { listToolbar, toolbarCount } from "../../kit/list-toolbar"
import { filteredEmpty } from "../../kit/signal-empty-state"
import { ruleHref } from "../shared/links"
import { isoMs } from "../shared/time"
import { Message, type RuleBucket } from "./message"
import type { Model } from "./model"
import { ruleMenuId } from "./update"
import { searchInput } from "../../../ui/search-input"

// `RulesTab`: the hub's Rules tab.

const DAY_MS = 24 * 60 * 60 * 1000
const RIBBON_DAYS = 7
const RIBBON_CELLS = RIBBON_DAYS * 4
const FIRED_WINDOW_DAYS = 30
const RENDER_LIMIT = 100

const BUCKETS: ReadonlyArray<{ value: RuleBucket; label: string; tone: Tone }> = [
	{ value: "firing", label: "Firing", tone: "crit" },
	{ value: "blind", label: "Blind", tone: "warn" },
	{ value: "healthy", label: "Healthy", tone: "ok" },
	{ value: "disabled", label: "Disabled", tone: "neutral" },
]
const BUCKET_TONE = new Map<RuleBucket, Tone>(BUCKETS.map((bucket) => [bucket.value, bucket.tone]))

const ROW_GRID =
	"grid grid-cols-[12px_minmax(0,1fr)_170px_150px_minmax(0,160px)_48px_32px] items-center gap-4"

const capGroups = <T>(groups: ReadonlyArray<TagGroup<T>>, limit: number): Array<TagGroup<T>> =>
	groups.reduce<{ out: Array<TagGroup<T>>; left: number }>(
		(acc, group) =>
			acc.left <= 0
				? acc
				: {
						out: [...acc.out, { ...group, items: group.items.slice(0, acc.left) }],
						left: acc.left - group.items.length,
					},
		{ out: [], left: limit },
	).out

type H = HtmlBuilder<Message>

export type RulesTabInputs = Readonly<{
	data: AlertsOverviewReady
	destinations: ReadonlyArray<AlertDestinationDocument>
	status: RuleBucket | undefined
	emptyState: Html
}>

export const rulesTab = (h: H, model: Model, inputs: RulesTabInputs): Html => {
	const { data, destinations, status } = inputs
	const { rules, derivedByRuleId, incidentsByRule, timelineRange } = data
	const now = timelineRange.max
	if (rules.length === 0) return inputs.emptyState

	const bucketByRuleId = new Map(rules.map((rule) => [rule.id, ruleBucket(derivedByRuleId.get(rule.id))]))
	const bucketCounts = new Map<RuleBucket, number>()
	for (const bucket of bucketByRuleId.values())
		bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1)
	const cutoff = now - FIRED_WINDOW_DAYS * DAY_MS
	const firedByRuleId = new Map(
		rules.map((rule) => [
			rule.id,
			(incidentsByRule.get(rule.id) ?? []).filter((i) => isoMs(i.firstTriggeredAt) >= cutoff).length,
		]),
	)
	const totalFired = [...firedByRuleId.values()].reduce((sum, n) => sum + n, 0)
	const query = model.rulesQuery.trim().toLowerCase()
	const filtered = rules.filter((rule) => {
		if (status !== undefined && bucketByRuleId.get(rule.id) !== status) return false
		if (query === "") return true
		return (
			rule.name.toLowerCase().includes(query) ||
			rule.serviceNames.some((s) => s.toLowerCase().includes(query)) ||
			rule.tags.some((t) => t.toLowerCase().includes(query))
		)
	})
	const groups = groupByTag(filtered, (rule) => rule.tags)
	const totalRows = groups.reduce((sum, group) => sum + group.items.length, 0)
	const isCapped = !model.isShowingAllRules && totalRows > RENDER_LIMIT
	const visibleGroups = isCapped ? capGroups(groups, RENDER_LIMIT) : groups
	const destinationsById = new Map(destinations.map((d) => [d.id, d]))
	const ribbonRange = { min: now - RIBBON_DAYS * DAY_MS, max: now }

	const rowOf = (rule: AlertRuleDocument, groupKey: string) =>
		ruleRow(h, model, {
			rule,
			derived: derivedByRuleId.get(rule.id),
			bucket: bucketByRuleId.get(rule.id) ?? "healthy",
			lastValue: worstState(data.statesByRule.get(rule.id) ?? [])?.last_value ?? null,
			incidents: incidentsByRule.get(rule.id) ?? [],
			ribbonRange,
			destinations: rule.destinationIds
				.filter((id, i, all) => all.indexOf(id) === i)
				.flatMap((id) => {
					const destination = destinationsById.get(id)
					return destination === undefined ? [] : [destination]
				}),
			fired: firedByRuleId.get(rule.id) ?? 0,
			groupKey,
		})

	return h.div(
		[h.Class("space-y-4")],
		[
			listToolbar(h, {
				className: "pb-0",
				leading: h.div(
					[h.Class("flex flex-wrap items-center gap-2")],
					[
						rulesSearch(h, model.rulesQuery),
						...BUCKETS.map((bucket) =>
							filterChip(
								h,
								{
									isPressed: status === bucket.value,
									onClick: Message.ClickedStatusFilter({ bucket: bucket.value }),
									tone: bucket.tone,
									hasDot: true,
									count: String(bucketCounts.get(bucket.value) ?? 0),
								},
								[bucket.label],
							),
						),
					],
				),
				trailing: [
					toolbarCount(h, [
						countLabel(rules.length, "rule"),
						" · ",
						String(totalFired),
						" fired in ",
						String(FIRED_WINDOW_DAYS),
						"d",
					]),
				],
			}),
			...(model.hasToggleFailed
				? [
						alert(h, { variant: "crit", size: "sm" }, [
							alertDescription(h, ["Couldn't update the rule. Try again."]),
						]),
					]
				: []),
			filtered.length === 0
				? filteredEmpty(h, {
						noun: "rules",
						description: "Try a different search term or status.",
						onClear: Message.ClickedClearRuleFilters(),
						className: "py-12",
					})
				: h.div(
						[h.Class("overflow-x-auto rounded-md border")],
						[
							h.div(
								[h.Class("min-w-[900px]")],
								[
									h.div(
										[
											h.Class(
												cn(
													ROW_GRID,
													"border-b px-4 py-2 text-xs text-muted-foreground",
												),
											),
										],
										[
											h.span([], []),
											h.span([], ["Rule"]),
											h.span([], ["Headroom now"]),
											h.span([], ["Last ", String(RIBBON_DAYS), " days"]),
											h.span([], ["Routes to"]),
											h.span(
												[h.Class("text-right")],
												["Fired ", String(FIRED_WINDOW_DAYS), "d"],
											),
											h.span([], []),
										],
									),
									...visibleGroups.map((group) => {
										const firingInGroup = group.items.filter(
											(r) => bucketByRuleId.get(r.id) === "firing",
										).length
										return h.section(
											[h.Key(group.key), h.Class("border-b last:border-b-0")],
											[
												h.div(
													[h.Class("border-b bg-surface-sunken px-4 py-2 text-xs")],
													[
														h.span(
															[h.Class("font-medium")],
															[
																group.key === UNTAGGED_KEY
																	? "No tag"
																	: group.label,
															],
														),
														h.span(
															[h.Class("text-muted-foreground")],
															[
																" ",
																countLabel(group.count, "rule"),
																...(firingInGroup > 0
																	? [` · ${firingInGroup} firing`]
																	: []),
															],
														),
													],
												),
												h.ul(
													[h.Class("divide-y")],
													group.items.map((rule) => rowOf(rule, group.key)),
												),
											],
										)
									}),
								],
							),
						],
					),
			...(isCapped
				? [
						h.div(
							[h.Class("flex justify-center")],
							[
								button(
									h,
									{
										variant: "outline",
										size: "sm",
										attributes: [h.OnClick(Message.ClickedShowAllRules())],
									},
									[`Show all ${totalRows.toLocaleString("en-US")}`],
								),
							],
						),
					]
				: []),
		],
	)
}

/** `SearchInput size="sm"`, the toolbar size. */
const rulesSearch = (h: H, value: string): Html =>
	searchInput(h, {
		id: "alerts-rules-search",
		size: "sm",
		className: "w-full max-w-xs",
		placeholder: "Search rules, services, tags…",
		value,
		onInput: (next) => Message.ChangedRulesQuery({ value: next }),
		onClear: Message.ChangedRulesQuery({ value: "" }),
	})

type RowInputs = Readonly<{
	rule: AlertRuleDocument
	derived: DerivedRuleStatus | undefined
	bucket: RuleBucket
	lastValue: number | null
	incidents: ReadonlyArray<AlertIncidentDocument>
	ribbonRange: Readonly<{ min: number; max: number }>
	destinations: ReadonlyArray<AlertDestinationDocument>
	fired: number
	/** A rule with several tags is listed once per tag: its menu is one per row. */
	groupKey: string
}>

const ruleRow = (h: H, model: Model, row: RowInputs): Html => {
	const { rule } = row
	const menuId = ruleMenuId(rule.id, row.groupKey)
	const entries: ReadonlyArray<MenuEntry> = [
		{ _tag: "Item", value: "open", label: "Open rule" },
		{
			_tag: "Item",
			value: "toggle",
			label: rule.enabled ? "Disable rule" : "Enable rule",
			isDisabled: model.togglingRuleId !== null,
		},
	]
	return h.li(
		[h.Key(rule.id), h.Class(cn(ROW_GRID, "relative px-4 py-3 hover:bg-surface-sunken active:bg-surface-sunken"))],
		[
			statusDot(h, { tone: BUCKET_TONE.get(row.bucket) ?? "neutral", size: "lg" }),
			h.div(
				[h.Class("min-w-0 space-y-0.5")],
				[
					rowLink(
						h,
						{
							href: ruleHref(rule.id),
							className: cn(
								"block truncate text-sm font-medium",
								!rule.enabled && "text-muted-foreground",
							),
							attributes: [h.Title(rule.name)],
						},
						[rule.name],
					),
					h.p(
						[h.Class("truncate font-mono text-xs text-muted-foreground")],
						[ruleConditionSummary(rule)],
					),
				],
			),
			headroomMeter(h, rule, row.derived, row.lastValue),
			stateRibbon(h, ruleRibbon(row.incidents, row.ribbonRange, RIBBON_CELLS)),
			routesTo(h, row.destinations, rule.enabled),
			h.span(
				[
					h.Class(
						cn(
							"text-right font-mono text-xs tabular-nums",
							row.fired === 0 && "text-muted-foreground",
						),
					),
				],
				[String(row.fired)],
			),
			h.span(
				[h.Class(ROW_LINK_LIFT)],
				model.isAdmin
					? [
							rowActionsMenu(h, {
								slotId: menuId,
								model: model.menus[menuId] ?? Menu.init(menuId),
								entries,
								label: `Actions for ${rule.name}`,
								toParentMessage: (message) => Message.GotRowMenuMessage({ menuId, message }),
							}),
						]
					: [],
			),
		],
	)
}

const headroomMeter = (
	h: H,
	rule: AlertRuleDocument,
	derived: DerivedRuleStatus | undefined,
	value: number | null,
): Html => {
	if (!rule.enabled) return h.span([h.Class("text-xs text-muted-foreground")], ["Not evaluating"])
	if (derived?.status === "error")
		return h.span([h.Class("text-xs text-severity-error")], ["Query fails to run"])
	if (value === null) return h.span([h.Class("text-xs text-muted-foreground")], ["Waiting on data"])
	const meter = ruleHeadroom(rule, value)
	const tone = meter.breached
		? "bg-severity-error"
		: meter.headroom !== null && meter.headroom < 0.2
			? "bg-severity-warn"
			: "bg-severity-info"
	const label = meter.breached
		? "over threshold"
		: meter.headroom !== null
			? `${Math.round(meter.headroom * 100)}% headroom`
			: "within threshold"
	return h.div(
		[h.Class("min-w-0 space-y-1")],
		[
			h.div(
				[h.Class("relative h-1.5 rounded-full bg-muted")],
				[
					h.span([
						h.Class(cn("absolute inset-y-0 left-0 rounded-full", tone)),
						h.Style({ width: `${meter.fill * 100}%` }),
					]),
					...meter.ticks.map((tick) =>
						h.span([
							h.Key(String(tick)),
							h.AriaHidden(true),
							h.Class("absolute -top-0.5 h-2.5 w-px bg-foreground/70"),
							h.Style({ left: `${tick * 100}%` }),
						]),
					),
				],
			),
			h.p(
				[
					h.Class(
						cn(
							"truncate font-mono text-2xs",
							meter.breached ? "text-severity-error" : "text-muted-foreground",
						),
					),
				],
				[formatSignalValue(rule.signalType, value), " · ", label],
			),
		],
	)
}

const RIBBON_CLASS = new Map<RibbonCell, string>([
	["quiet", "bg-muted"],
	["warning", "bg-severity-warn"],
	["critical", "bg-severity-error"],
])

const stateRibbon = (h: H, cells: ReadonlyArray<RibbonCell>): Html =>
	h.div(
		[h.Class("flex h-3.5 items-stretch gap-px"), h.AriaLabel("Incidents over the last 7 days")],
		cells.map((cell) => h.span([h.Class(cn("flex-1 rounded-2xs", RIBBON_CLASS.get(cell)))])),
	)

const routesTo = (h: H, destinations: ReadonlyArray<AlertDestinationDocument>, isEnabled: boolean): Html => {
	if (destinations.length === 0)
		return h.span(
			[h.Class(cn("text-xs", isEnabled ? "text-severity-warn" : "text-muted-foreground"))],
			["Nobody"],
		)
	const names = destinations.map((d) => d.name).join(", ")
	return h.span([h.Class("truncate text-xs"), h.Title(names)], [names])
}
