import { auditActionLabel } from "@maple/domain/audit-actions"
import type { AuditActorType, AuditLogSource } from "@maple/domain/http"
import { encodePublicId, PublicIdPrefixes, type V2ApiKey, type V2AuditLogEntry } from "@maple/domain/http/v2"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { initialsFrom } from "@maple/ui/lib/initials"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import {
	AUDIT_RANGE_PRESETS,
	type AuditDateRange,
	hasAuditLogFilters,
	parseAuditLogSearch,
} from "../../../components/settings/audit-log-filters"
import { auditResourceDisplay } from "../../../components/settings/audit-log-resource"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { SettingsSearch as SettingsSearchSchema } from "../../../route/search"
import { button } from "../../../ui/button"
import { avatarFallback, badge } from "../../../ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { listFooter } from "../../../ui/list-footer"
import { panelStyles, panelToneStyles } from "@maple/ui/styles/ui/panel"
import * as Popover from "../../../ui/popover"
import { refreshButton } from "../../../ui/refresh-button"
import { segmentedSelect } from "../../../ui/segmented-select"
import * as SelectView from "../../../ui/select-view"
import { skeletonList } from "../../../ui/skeleton"
import { truncatedText } from "../../../ui/truncated-text"
import { relativeTime } from "../../kit/relative-time"
import { settingsSection } from "../kit/section"
import { Message, type Model } from "./model"
import { ANYONE } from "./update"
import { auditDetail, resourceHref } from "./view-detail"

type H = HtmlBuilder<Message>
type SettingsSearch = typeof SettingsSearchSchema.Type
export type ViewInputs = Readonly<{
	search: SettingsSearch
	nowMs: number
	timeZone: string
	apiKeys: ReadonlyArray<V2ApiKey>
}>

const ACTOR_FILTERS = [
	{ value: "all", label: "All" },
	{ value: "user", label: "Users" },
	{ value: "api_key", label: "API keys" },
	{ value: "agent", label: "Agents" },
	{ value: "system", label: "System" },
] as const
const OUTCOME_FILTERS = [
	{ value: "all", label: "All" },
	{ value: "allowed", label: "Allowed" },
	{ value: "denied", label: "Denied" },
] as const

export const SOURCE_LABELS = {
	dashboard: "Dashboard",
	api: "API",
	mcp: "MCP",
	chat_platform: "Chat",
	system: "System",
} as const satisfies { readonly [Source in AuditLogSource]: string }

export const ACTOR_BADGES = {
	user: { label: "User", variant: "secondary" },
	api_key: { label: "API key", variant: "ok" },
	agent: { label: "Agent", variant: "info" },
	system: { label: "System", variant: "outline" },
} as const satisfies {
	readonly [Actor in AuditActorType]: { label: string; variant: "secondary" | "ok" | "info" | "outline" }
}

const COL = {
	time: "flex w-22 shrink-0 items-center gap-2",
	actor: "min-w-0 flex-1 @md:w-38 @md:flex-none",
	action: "min-w-0 basis-full pl-5 @md:basis-0 @md:flex-1 @md:pl-0",
	resource: "hidden w-56 min-w-0 shrink-0 @3xl:block",
	source: "hidden w-20 shrink-0 @2xl:block",
	outcome: "hidden w-15 shrink-0 @md:block",
}

const initialsOf = (label: string) => (label.startsWith("user_") ? "?" : initialsFrom(label))

const abbreviateId = (id: string): string => {
	const prefixEnd = id.indexOf("_")
	if (prefixEnd === -1 || id.length <= prefixEnd + 10) return id
	return `${id.slice(0, prefixEnd + 1)}…${id.slice(-5)}`
}

const actorDisplayName = (entry: V2AuditLogEntry): string | null =>
	entry.actor_name ?? (entry.actor_id === null ? null : abbreviateId(entry.actor_id))

const rangeLabel = (range: AuditDateRange, timeZone: string): string => {
	if (range.kind === "all") return "All time"
	if (range.kind === "preset")
		return AUDIT_RANGE_PRESETS.find((preset) => preset.value === range.preset)?.label ?? "All time"
	const format = (value: string) => formatTimestampInTimezone(value, { timeZone })
	if (range.since !== undefined && range.until !== undefined)
		return `${format(range.since)} to ${format(range.until)}`
	if (range.since !== undefined) return `Since ${format(range.since)}`
	if (range.until !== undefined) return `Until ${format(range.until)}`
	return "All time"
}

// TOOLBAR

const dateRange = (h: H, model: Model, range: AuditDateRange, timeZone: string): Html => {
	const label = rangeLabel(range, timeZone)
	const activeKey = range.kind === "all" ? "all" : range.kind === "preset" ? range.preset : null
	const options = [
		{ key: "all", label: "All time" },
		...AUDIT_RANGE_PRESETS.map((preset) => ({ key: preset.value, label: preset.label })),
	]
	return h.submodel({
		slotId: "audit-date-range",
		model: model.dateRange,
		view: Popover.view,
		toParentMessage: (message) => Message.GotDateRangeMessage({ message }),
		viewInputs: {
			className: "w-48 p-0",
			toView: ({ trigger, withTrigger }) =>
				h.div(
					[h.Class("contents")],
					withTrigger(
						button(
							h,
							{
								variant: "outline",
								size: "sm",
								className: "gap-1.5",
								slot: "popover-trigger",
								attributes: [h.AriaLabel(`Date range: ${label}`), ...trigger],
							},
							[icon(h, "ClockIcon"), h.span([], [label])],
						),
					),
				),
			// TODO(settings-audit): "Custom range…" opens `CustomRangePicker`, not ported (shared with the
			// time-range picker's custom tab); it is drawn without its picker.
			toContent: () => [
				h.div(
					[h.Class("flex flex-col py-1.5")],
					[
						...options.map((option) =>
							h.button(
								[
									h.Key(option.key),
									h.Type("button"),
									h.OnClick(Message.ClickedRangePreset({ value: option.key })),
									h.Class(
										cn(
											"flex h-7 items-center px-3 text-left text-xs transition-colors hover:bg-muted/50",
											option.key === activeKey
												? "font-medium text-foreground"
												: "text-foreground/80",
										),
									),
								],
								[option.label],
							),
						),
						h.div([h.Class("mx-3 my-1 h-px bg-border/60")], []),
						h.button(
							[
								h.Type("button"),
								h.Class(
									cn(
										"flex h-7 items-center px-3 text-left text-xs transition-colors hover:bg-muted/50 hover:text-foreground",
										range.kind === "custom"
											? "font-medium text-foreground"
											: "text-muted-foreground",
									),
								),
							],
							["Custom range…"],
						),
					],
				),
			],
		},
	})
}

const personFilter = (
	h: H,
	model: Model,
	actorId: string | undefined,
	apiKeys: ReadonlyArray<V2ApiKey>,
): Html => {
	// Audit rows name a key by its public `key_…` id; the synced rows carry the internal one.
	const keyOptions = apiKeys.map((key) => ({
		value: encodePublicId(PublicIdPrefixes.apiKey, key.id),
		label: key.name,
	}))
	const selected = [...model.members, ...keyOptions].find((option) => option.value === actorId)
	const label = actorId === undefined ? "Anyone" : (selected?.label ?? actorId)
	const group = (
		groupLabel: string,
		items: ReadonlyArray<SelectView.SelectOption>,
	): ReadonlyArray<SelectView.SelectEntry> =>
		items.length > 0 ? [{ _tag: "Group", label: groupLabel, items }] : []
	const entries: ReadonlyArray<SelectView.SelectEntry> = [
		{ _tag: "Item", item: { value: ANYONE, label: "Anyone" } },
		...group("Members", model.members),
		...group("API keys", keyOptions),
	]
	return h.submodel({
		slotId: "audit-person",
		model: { ...model.personSelect, value: actorId ?? ANYONE },
		view: SelectView.view,
		toParentMessage: (message) => Message.GotPersonSelectMessage({ message }),
		viewInputs: {
			entries,
			ariaLabel: "Person",
			size: "sm",
			className: "w-auto min-w-40 max-w-64",
			renderValue: () => [h.span([h.Class("truncate")], [label])],
			toView: (parts) => h.div([h.Class("contents")], parts),
		},
	})
}

// ROWS

const actorCell = (h: H, entry: V2AuditLogEntry): Html => {
	const actor = ACTOR_BADGES[entry.actor_type]
	const name = actorDisplayName(entry)
	return h.div(
		[h.Class(cn(COL.actor, "flex items-center gap-1.5"))],
		[
			entry.actor_type === "user"
				? avatarFallback(
						h,
						{ className: "size-4 shrink-0 text-4xs" },
						initialsOf(entry.actor_name ?? entry.actor_id ?? ""),
					)
				: badge(h, { variant: actor.variant, size: "sm", className: "shrink-0" }, [actor.label]),
			...(name === null
				? []
				: [
						truncatedText(
							h,
							{
								text:
									entry.actor_name !== null && entry.actor_id !== null
										? `${name} (${entry.actor_id})`
										: (entry.actor_id ?? name),
								className: cn(
									"text-xs",
									entry.actor_name === null && "text-muted-foreground",
								),
							},
							[name],
						),
					]),
		],
	)
}

const actionLabel = (h: H, action: string): ReadonlyArray<Html> => {
	const label = auditActionLabel(action)
	if (label === null) return [truncatedText(h, { mono: true, text: action, className: "text-xs" })]
	return [
		truncatedText(h, { text: label, className: "text-xs text-foreground" }),
		truncatedText(h, { mono: true, text: action, className: "text-3xs text-muted-foreground" }),
	]
}

const deniedBadge = (h: H) => badge(h, { variant: "crit", size: "sm", className: "shrink-0" }, ["Denied"])

const resourceCell = (h: H, entry: V2AuditLogEntry): Html => {
	const display = auditResourceDisplay(entry)
	if (display === null) return h.span([h.Class("text-muted-foreground text-xs")], [EMPTY_VALUE])
	if (display.link === null) return truncatedText(h, { text: display.text, className: "text-xs" })
	return h.a(
		[
			h.Href(resourceHref(display.link)),
			h.Class(
				"relative z-10 block truncate text-xs text-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground",
			),
			h.Title(display.text),
		],
		[display.text],
	)
}

const auditRow = (h: H, model: Model, entry: V2AuditLogEntry, inputs: ViewInputs): Html => {
	const isExpanded = model.expanded.includes(entry.id)
	const detailId = `audit-entry-${entry.id}`
	const isDenied = entry.outcome === "denied"
	const label = auditActionLabel(entry.action) ?? entry.action
	return h.div(
		[h.Key(entry.id), ...(isExpanded ? [h.Class("bg-muted/10")] : [])],
		[
			h.div(
				[
					h.Class(
						"hover:bg-muted/20 relative flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 transition-colors @md:flex-nowrap",
					),
				],
				[
					h.button(
						[
							h.Type("button"),
							h.AriaExpanded(isExpanded),
							h.AriaControls(detailId),
							h.AriaLabel(`${isExpanded ? "Hide" : "Show"} details: ${label}`),
							h.OnClick(Message.ToggledEntry({ id: entry.id })),
							h.Class(
								"focus-visible:ring-ring absolute inset-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset",
							),
						],
						[],
					),
					h.span(
						[h.Class(cn(COL.time, "text-muted-foreground text-xs"))],
						[
							icon(h, "ChevronRightIcon", {
								size: 12,
								className: cn(
									"text-muted-foreground/60 shrink-0 transition-transform",
									isExpanded && "rotate-90",
								),
							}),
							relativeTime(h, {
								value: entry.occurred_at,
								nowMs: inputs.nowMs,
								timeZone: inputs.timeZone,
								tooltip: "title",
							}),
						],
					),
					actorCell(h, entry),
					h.div(
						[h.Class(cn(COL.action, "flex min-w-0 flex-col"))],
						[
							h.div(
								[h.Class("flex min-w-0 items-center gap-1.5")],
								[
									h.div([h.Class("flex min-w-0 flex-col")], actionLabel(h, entry.action)),
									...(isDenied ? [h.span([h.Class("@md:hidden")], [deniedBadge(h)])] : []),
								],
							),
							...(isDenied && entry.denial_reason !== null
								? [
										truncatedText(h, {
											text: entry.denial_reason,
											className: "text-muted-foreground text-2xs",
										}),
									]
								: []),
						],
					),
					h.div([h.Class(COL.resource)], [resourceCell(h, entry)]),
					h.span(
						[h.Class(COL.source)],
						[badge(h, { variant: "outline", size: "sm" }, [SOURCE_LABELS[entry.source]])],
					),
					h.span([h.Class(COL.outcome)], isDenied ? [deniedBadge(h)] : []),
				],
			),
			...(isExpanded ? [h.div([h.Id(detailId)], [auditDetail(h, model, entry, inputs.timeZone)])] : []),
		],
	)
}

const headerRow = (h: H): Html =>
	h.div(
		[h.Class("hidden items-center gap-3 px-4 py-2 @md:flex"), h.AriaHidden(true)],
		[
			eyebrow(h, { variant: "mono", className: COL.time }, [
				h.span([h.Class("w-3 shrink-0")], []),
				"Time",
			]),
			eyebrow(h, { variant: "mono", className: COL.actor }, ["Actor"]),
			eyebrow(h, { variant: "mono", className: COL.action }, ["Action"]),
			eyebrow(h, { variant: "mono", className: COL.resource }, ["Resource"]),
			eyebrow(h, { variant: "mono", className: COL.source }, ["Source"]),
			eyebrow(h, { variant: "mono", className: COL.outcome }, ["Outcome"]),
		],
	)

const emptyState = (h: H, title: string, description: string, action: ReadonlyArray<Html>): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "HistoryIcon", { size: 16 })]),
				emptyTitle(h, [title]),
				emptyDescription(h, [description]),
			]),
			...action,
		],
		"py-8",
	)

const listBody = (h: H, model: Model, inputs: ViewInputs, isFiltered: boolean): Html => {
	const view = model.view
	if (view === null && model.failure !== null)
		return errorState(h, {
			failure: model.failure,
			title: "Couldn't load the audit log",
			onRetry: Message.ClickedRetry(),
			className: "border-0",
		})
	if (view === null)
		return skeletonList(h, { rows: 3, rowClassName: "h-[44px]", gap: "2", className: "p-4" })
	if (view.entries.length === 0 && isFiltered)
		return emptyState(
			h,
			"No entries match these filters",
			"Nothing recorded for this range, person, actor type and outcome.",
			[
				button(
					h,
					{
						variant: "outline",
						size: "sm",
						attributes: [h.OnClick(Message.ClickedClearFilters())],
					},
					["Clear filters"],
				),
			],
		)
	if (view.entries.length === 0)
		return emptyState(
			h,
			"No audit log entries",
			"Actions and data reads by users, API keys, and agents will appear here.",
			[],
		)
	return h.div(
		[h.Class("divide-border divide-y")],
		[headerRow(h), ...view.entries.map((entry) => auditRow(h, model, entry, inputs))],
	)
}

export const description =
	"Every change, refused attempt and data read from the dashboard, API, MCP and chat. Select an entry for its full record."

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const filters = parseAuditLogSearch(inputs.search)
	const isFailed = model.failure !== null
	const isWaiting = model.isWaiting && !model.isQuiet
	const view = model.view
	return settingsSection(
		h,
		{
			id: "audit-log-heading",
			title: "Audit log",
			isLead: true,
			framed: false,
		},
		[
			h.div(
				[h.Class("flex flex-col gap-2")],
				[
					h.div(
						[h.Class("flex flex-wrap items-center gap-2")],
						[
							dateRange(h, model, filters.range, inputs.timeZone),
							personFilter(h, model, filters.actorId, inputs.apiKeys),
							// The labelled Reload every page header uses, beside the range it re-reads.
							refreshButton(h, {
								label: "Reload",
								isPending: isWaiting,
								onRefresh: Message.ClickedRefresh(),
							}),
						],
					),
					h.div(
						[h.Class("flex flex-wrap items-center gap-3")],
						[
							segmentedSelect(h, {
								size: "sm",
								ariaLabel: "Actor type",
								value: filters.actorType ?? "all",
								onChange: (value) => Message.ClickedActorType({ value }),
								options: ACTOR_FILTERS,
							}),
							segmentedSelect(h, {
								size: "sm",
								ariaLabel: "Outcome",
								value: filters.outcome ?? "all",
								onChange: (value) => Message.ClickedOutcome({ value }),
								options: OUTCOME_FILTERS,
							}),
						],
					),
				],
			),
			h.section(
				[
					h.AriaBusy(isWaiting),
					h.Class(
						cn(
							panelStyles,
							panelToneStyles.default,
							"@container",
							// A failed first load reads like every other failure block: a dashed frame.
							view === null && model.failure !== null && "border-dashed",
							refreshingClass(isWaiting && view !== null),
						),
					),
					h.DataAttribute("slot", "panel"),
				],
				[listBody(h, model, inputs, hasAuditLogFilters(filters))],
			),
			...(view !== null && isFailed && model.failure !== null
				? [
						errorState(h, {
							variant: "row",
							failure: model.failure,
							title:
								model.request.cursor === undefined
									? "Couldn't refresh the audit log"
									: "Couldn't load more entries",
							onRetry: Message.ClickedRetry(),
						}),
					]
				: []),
			...(view !== null && !isFailed && view.hasMore && view.nextCursor !== null
				? [
						listFooter(h, {
							shown: view.entries.length,
							noun: "entries",
							hasMore: true,
							isLoading: isWaiting,
							align: "start",
							className: "justify-start p-0",
							onLoadMore: Message.ClickedLoadMore(),
						}) ?? h.empty,
					]
				: []),
		],
	)
})
