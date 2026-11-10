import { auditActionLabel, AuditResourceLabels, AuditResources } from "@maple/domain/audit-actions"
import type { AuditActorType, AuditLogSource } from "@maple/domain/http"
import { encodePublicId, PublicIdPrefixes, type V2ApiKey, type V2AuditLogEntry } from "@maple/domain/http/v2"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { initialsFrom } from "@maple/ui/lib/initials"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import {
	AUDIT_RANGE_PRESETS,
	type AuditDateRange,
	type AuditLogFilters,
	auditLogKindOf,
	hasAuditLogFilters,
	parseAuditLogSearch,
} from "../kit/audit-log-filters"
import { compactSearchInput } from "@maple/views/ui/compact-search-input"
import { removableChip } from "@maple/views/ui/removable-chip"
import type { Message as SelectMessage } from "@maple/views/ui/select"
import * as CustomRangeView from "../../kit/custom-range-view"
import { auditResourceDisplay } from "../kit/audit-log-resource"
import { formatTimestampInTimezone } from "@maple/ui/lib/timezone-format"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { SettingsSearch as SettingsSearchSchema } from "../../../route/search"
import { button } from "@maple/views/ui/button"
import { avatarFallback, badge, separator } from "@maple/views/ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { listFooter } from "@maple/views/ui/list-footer"
import { panel } from "@maple/views/ui/panel"
import * as Popover from "@maple/views/ui/popover"
import { pressable } from "@maple/views/ui/pressable"
import { refreshButton } from "@maple/views/ui/refresh-button"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import * as SelectView from "@maple/views/ui/select-view"
import { skeletonList } from "@maple/views/ui/skeleton"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { relativeTime } from "../../kit/relative-time"
import { filteredEmpty } from "@maple/views/ui/signal-empty-state"
import { settingsSection } from "../kit/section"
import { Message, type Model } from "./model"
import { ANY, ANYONE } from "./update"
import { auditDetail, resourceHref } from "./view-detail"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, hstackClass, vstack, vstackClass } from "@maple/views/ui/stack"
import { Array as Arr, String as Str, Option, Order, Record as Rec } from "effect"
import { textLink } from "@maple/views/ui/text-link"

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
const KIND_OPTIONS = [
	{ value: "changes", label: "Changes" },
	{ value: "access", label: "Data access" },
	{ value: "all", label: "All" },
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

const initialsOf = (label: string) => (Str.startsWith("user_")(label) ? "?" : initialsFrom(label))

const abbreviateId = (id: string): string => {
	return Option.match(
		Option.filter(Str.indexOf("_")(id), (prefixEnd) => id.length > prefixEnd + 10),
		{
			onNone: () => id,
			onSome: (prefixEnd) => `${Str.slice(0, prefixEnd + 1)(id)}…${Str.slice(-5)(id)}`,
		},
	)
}

const actorDisplayName = (entry: V2AuditLogEntry): string | null =>
	entry.actor_name ?? (entry.actor_id === null ? null : abbreviateId(entry.actor_id))

const rangeLabel = (range: AuditDateRange, timeZone: string): string => {
	if (range.kind === "all") return "All time"
	if (range.kind === "preset")
		return Option.match(
			Arr.findFirst(AUDIT_RANGE_PRESETS, (preset) => preset.value === range.preset),
			{ onNone: () => "All time", onSome: (preset) => preset.label },
		)
	const format = (value: string) => formatTimestampInTimezone(value, { timeZone })
	if (range.since !== undefined && range.until !== undefined)
		return `${format(range.since)} to ${format(range.until)}`
	if (range.since !== undefined) return `Since ${format(range.since)}`
	if (range.until !== undefined) return `Until ${format(range.until)}`
	return "All time"
}

// TOOLBAR

const RANGE_OPTION_CLASS =
	"flex h-7 items-center px-3 text-left text-xs hover:bg-surface-sunken active:bg-surface-sunken"

const dateRange = (h: H, model: Model, range: AuditDateRange, timeZone: string): Html => {
	const label = rangeLabel(range, timeZone)
	const activeKey = range.kind === "all" ? "all" : range.kind === "preset" ? range.preset : null
	const options = [
		{ key: "all", label: "All time" },
		...Arr.map(AUDIT_RANGE_PRESETS, (preset) => ({ key: preset.value, label: preset.label })),
	]
	const optionClass = (isActive: boolean) =>
		cn(
			RANGE_OPTION_CLASS,
			isActive ? typographyClass({ tone: "foreground", weight: "medium" }) : "text-foreground-soft",
		)
	return h.submodel({
		slotId: "audit-date-range",
		model: model.dateRange,
		view: Popover.view,
		toParentMessage: (message) => Message.GotDateRangeMessage({ message }),
		viewInputs: {
			className: model.customRange === null ? "w-48 p-0" : "w-auto p-0",
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
			toContent: () => [
				model.customRange !== null
					? h.submodel({
							slotId: "audit-custom-range",
							model: model.customRange,
							view: CustomRangeView.view,
							viewInputs: {},
							toParentMessage: (message) => Message.GotCustomRangeMessage({ message }),
						})
					: vstack(h, { className: "py-1.5" }, [
							...Arr.map(options, (option) =>
								pressable(
									h,
									{
										onClick: Message.ClickedRangePreset({ value: option.key }),
										className: optionClass(option.key === activeKey),
										attributes: [h.Key(option.key)],
									},
									[option.label],
								),
							),
							separator(h, "horizontal", "mx-3 my-1 data-[orientation=horizontal]:w-auto"),
							pressable(
								h,
								{
									onClick: Message.ClickedCustomRange({ timeZone }),
									className: optionClass(range.kind === "custom"),
								},
								["Custom range…"],
							),
						]),
			],
		},
	})
}

/** A filter select with an "any" first item and the picked label shown in the trigger. */
const filterSelect = (
	h: H,
	options: Readonly<{
		slotId: string
		model: Model["resourceTypeSelect"]
		value: string | undefined
		anyLabel: string
		ariaLabel: string
		items: ReadonlyArray<SelectView.SelectOption>
		toMessage: (message: SelectMessage) => Message
	}>,
): Html => {
	const label =
		options.value === undefined
			? options.anyLabel
			: Option.match(
					Arr.findFirst(options.items, (item) => item.value === options.value),
					{ onNone: () => options.value ?? options.anyLabel, onSome: (item) => item.label },
				)
	return h.submodel({
		slotId: options.slotId,
		model: { ...options.model, value: options.value ?? ANY },
		view: SelectView.view,
		toParentMessage: options.toMessage,
		viewInputs: {
			entries: [
				{ _tag: "Item", item: { value: ANY, label: options.anyLabel } },
				...Arr.map(options.items, (item): SelectView.SelectEntry => ({ _tag: "Item", item })),
			],
			ariaLabel: options.ariaLabel,
			size: "sm",
			className: "w-auto min-w-36 max-w-64",
			renderValue: () => [
				typography(
					h,
					{ truncate: true, tone: options.value === undefined ? "muted" : "foreground" },
					[label],
				),
			],
			toView: (parts) => h.div([h.Class("contents")], parts),
		},
	})
}

const byLabel = Order.mapInput(Order.String, (item: SelectView.SelectOption) => item.label)

const RESOURCE_TYPE_ITEMS: ReadonlyArray<SelectView.SelectOption> = Arr.sort(
	Arr.map(Rec.toEntries(AuditResourceLabels), ([value, label]) => ({ value, label })),
	byLabel,
)

const actionItems = (resourceType: string): ReadonlyArray<SelectView.SelectOption> =>
	Option.match(
		Arr.findFirst(Rec.toEntries(AuditResources), ([key]) => key === resourceType),
		{
			onNone: () => [],
			onSome: ([, resource]) => {
				const verbs: ReadonlyArray<string> = resource.verbs
				return Arr.map(verbs, (verb) => {
					const action = `${resourceType}.${verb}`
					return { value: action, label: auditActionLabel(action) ?? action }
				})
			},
		},
	)

const personFilter = (
	h: H,
	model: Model,
	actorId: string | undefined,
	apiKeys: ReadonlyArray<V2ApiKey>,
): Html => {
	// Audit rows name a key by its public `key_…` id; the synced rows carry the internal one.
	const keyOptions = Arr.map(apiKeys, (key) => ({
		value: encodePublicId(PublicIdPrefixes.apiKey, key.id),
		label: key.name,
	}))
	const label =
		actorId === undefined
			? "Anyone"
			: Option.match(
					Arr.findFirst([...model.members, ...keyOptions], (option) => option.value === actorId),
					{ onNone: () => actorId, onSome: (option) => option.label },
				)
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
			renderValue: () => [typography(h, { truncate: true }, [label])],
			toView: (parts) => h.div([h.Class("contents")], parts),
		},
	})
}

// ROWS

const actorCell = (h: H, entry: V2AuditLogEntry): Html => {
	const actor = ACTOR_BADGES[entry.actor_type]
	const name = actorDisplayName(entry)
	return h.div(
		[h.Class(cn(COL.actor, hstackClass({ gap: "1.5" })))],
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
		truncatedText(h, { text: label, className: typographyClass({ size: "xs", tone: "foreground" }) }),
		truncatedText(h, {
			mono: true,
			text: action,
			className: typographyClass({ size: "3xs", tone: "muted" }),
		}),
	]
}

const deniedBadge = (h: H) => badge(h, { variant: "crit", size: "sm", className: "shrink-0" }, ["Denied"])

const resourceCell = (h: H, entry: V2AuditLogEntry): Html => {
	const display = auditResourceDisplay(entry)
	if (display === null) return typography(h, { size: "xs", tone: "muted" }, [EMPTY_VALUE])
	if (display.link === null) return truncatedText(h, { text: display.text, className: "text-xs" })
	return textLink(
		h,
		{
			href: resourceHref(display.link),
			tone: "inherit",
			className:
				"relative z-10 block truncate text-xs text-foreground underline decoration-muted-foreground/40 hover:decoration-foreground active:decoration-foreground",
			attributes: [h.Title(display.text)],
		},
		[display.text],
	)
}

const auditRow = (h: H, model: Model, entry: V2AuditLogEntry, inputs: ViewInputs): Html => {
	const isExpanded = model.expanded.includes(entry.id)
	const detailId = `audit-entry-${entry.id}`
	const isDenied = entry.outcome === "denied"
	const label = auditActionLabel(entry.action) ?? entry.action
	return h.div(
		[h.Key(entry.id), ...(isExpanded ? [h.Class("bg-surface-faint")] : [])],
		[
			hstack(
				h,
				{
					align: "center",
					wrap: true,
					className:
						"hover:bg-surface-sunken active:bg-surface-sunken relative w-full gap-x-3 gap-y-1 px-4 py-2.5 @md:flex-nowrap",
				},
				[
					pressable(
						h,
						{
							onClick: Message.ToggledEntry({ id: entry.id }),
							label: `${isExpanded ? "Hide" : "Show"} details: ${label}`,
							className:
								"focus-visible:ring-ring absolute inset-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset",
							attributes: [h.AriaExpanded(isExpanded), h.AriaControls(detailId)],
						},
						[],
					),
					h.span(
						[h.Class(cn(COL.time, typographyClass({ size: "xs", tone: "muted" })))],
						[
							icon(h, "ChevronRightIcon", {
								size: 12,
								className: cn(
									"text-foreground-subtle shrink-0 transition-transform",
									isExpanded && "rotate-90",
								),
							}),
							relativeTime(h, {
								value: entry.occurred_at,
								nowMs: inputs.nowMs,
								timeZone: inputs.timeZone,
							}),
						],
					),
					actorCell(h, entry),
					h.div(
						[h.Class(cn(COL.action, vstackClass({ shrink: true })))],
						[
							hstack(h, { gap: "1.5", shrink: true }, [
								vstack(h, { shrink: true }, actionLabel(h, entry.action)),
								...(isDenied ? [h.span([h.Class("@md:hidden")], [deniedBadge(h)])] : []),
							]),
							...(isDenied && entry.denial_reason !== null
								? [
										truncatedText(h, {
											text: entry.denial_reason,
											className: typographyClass({ size: "2xs", tone: "muted" }),
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
			...(isExpanded
				? [h.div([h.Id(detailId)], [auditDetail(h, model, entry, inputs.timeZone, inputs.nowMs)])]
				: []),
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
		return filteredEmpty(h, {
			noun: "entries",
			description: "Nothing recorded for this range, person, actor type and outcome.",
			onClear: Message.ClickedClearFilters(),
			className: "py-8",
		})
	if (view.entries.length === 0)
		return empty(
			h,
			[
				emptyHeader(h, [
					emptyMedia(h, { variant: "icon" }, [icon(h, "HistoryIcon")]),
					emptyTitle(h, ["No audit log entries"]),
					emptyDescription(h, [
						"Actions and data reads by users, API keys, and agents will appear here.",
					]),
				]),
			],
			"py-8",
		)
	return h.div(
		[h.Class("divide-border divide-y")],
		[headerRow(h), ...Arr.map(view.entries, (entry) => auditRow(h, model, entry, inputs))],
	)
}

/** Filters that have no control of their own, shown as removable chips (a looked-up id, an action). */
const filterChips = (h: H, model: Model, filters: AuditLogFilters): ReadonlyArray<Html> => {
	const memberName = (userId: string) =>
		Option.match(
			Arr.findFirst(model.members, (member) => member.value === userId),
			{ onNone: () => userId, onSome: (member) => member.label },
		)
	const chips: ReadonlyArray<{ key: string; label: string } | null> = [
		filters.resourceId === undefined
			? null
			: { key: "resourceId", label: `Resource ${filters.resourceId}` },
		filters.requestId === undefined ? null : { key: "requestId", label: `Request ${filters.requestId}` },
		// With a resource type picked, the action has its own select.
		filters.action === undefined || filters.resourceType !== undefined
			? null
			: { key: "action", label: auditActionLabel(filters.action) ?? filters.action },
		filters.affectedUserId === undefined || model.members.length > 0
			? null
			: { key: "affectedUserId", label: `Affected ${memberName(filters.affectedUserId)}` },
	]
	return Arr.flatMap(chips, (chip) =>
		chip === null
			? []
			: [
					removableChip(h, {
						label: chip.label,
						onRemove: Message.RemovedFilter({ key: chip.key }),
						attributes: [h.Key(chip.key)],
					}),
				],
	)
}

const lookupField = (h: H, model: Model): ReadonlyArray<Html> => [
	compactSearchInput(h, {
		value: model.lookup,
		placeholder: "Paste an ID or action, then Enter",
		ariaLabel: "Look up an ID or action",
		onInput: (value) => Message.ChangedLookup({ value }),
		onEnter: Message.SubmittedLookup(),
		onClear: Message.ClearedLookup(),
		clearLabel: "Clear lookup",
		className: "h-8 w-full @lg:w-72",
	}),
	...(model.isLookupUnknown
		? [
				typography(h, { size: "2xs", tone: "muted", attributes: [h.Role("status")] }, [
					"Not something the log filters by. Paste a user, API key, agent, resource or request ID, or an action like dashboard.updated.",
				]),
			]
		: []),
]

const KIND_DESCRIPTIONS = {
	changes: "Changes and refused attempts. Data reads are under Data access.",
	access: "Reads of telemetry and replays, MCP tool calls, SQL statements and API requests.",
	all: "Every entry, changes and data access together.",
} as const

export const description =
	"Every change, refused attempt and data read from the dashboard, API, MCP and chat. Select an entry for its full record."

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const filters = parseAuditLogSearch(inputs.search)
	const kind = auditLogKindOf(filters)
	const isFailed = model.failure !== null
	const isWaiting = model.isWaiting && !model.isQuiet
	const view = model.view
	const chips = filterChips(h, model, filters)
	return settingsSection(
		h,
		{
			id: "audit-log-heading",
			title: "Audit log",
			isLead: true,
			framed: false,
		},
		[
			vstack(h, { gap: "3", className: "@container" }, [
				hstack(h, { gap: "3", wrap: true, align: "center", justify: "between" }, [
					hstack(h, { gap: "3", wrap: true, align: "center" }, [
						segmentedSelect(h, {
							size: "sm",
							ariaLabel: "Show",
							value: kind,
							onChange: (value) => Message.ClickedKind({ value }),
							options: KIND_OPTIONS,
						}),
						typography(h, { size: "xs", tone: "muted", className: "hidden @2xl:block" }, [
							KIND_DESCRIPTIONS[kind],
						]),
					]),
					// The labelled Reload every page header uses, beside the range it re-reads.
					refreshButton(h, {
						label: "Reload",
						isPending: isWaiting,
						onRefresh: Message.ClickedRefresh(),
					}),
				]),
				hstack(h, { gap: "2", wrap: true, align: "center" }, [
					dateRange(h, model, filters.range, inputs.timeZone),
					personFilter(h, model, filters.actorId, inputs.apiKeys),
					filterSelect(h, {
						slotId: "audit-resource-type",
						model: model.resourceTypeSelect,
						value: filters.resourceType,
						anyLabel: "Any resource",
						ariaLabel: "Resource type",
						items: RESOURCE_TYPE_ITEMS,
						toMessage: (message) => Message.GotResourceTypeSelectMessage({ message }),
					}),
					...(filters.resourceType === undefined
						? []
						: [
								filterSelect(h, {
									slotId: "audit-action",
									model: model.actionSelect,
									value: filters.action,
									anyLabel: "Any action",
									ariaLabel: "Action",
									items: actionItems(filters.resourceType),
									toMessage: (message) => Message.GotActionSelectMessage({ message }),
								}),
							]),
					...(model.members.length === 0
						? []
						: [
								filterSelect(h, {
									slotId: "audit-affected",
									model: model.affectedSelect,
									value: filters.affectedUserId,
									anyLabel: "Any affected user",
									ariaLabel: "Affected user",
									items: model.members,
									toMessage: (message) => Message.GotAffectedSelectMessage({ message }),
								}),
							]),
				]),
				hstack(h, { gap: "3", wrap: true, align: "center", justify: "between" }, [
					hstack(h, { gap: "3", wrap: true }, [
						segmentedSelect(h, {
							size: "sm",
							ariaLabel: "Actor type",
							// Five options outgrow a phone; the group scrolls instead of the page.
							className: "max-w-full overflow-x-auto",
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
					]),
					vstack(h, { gap: "1", className: "w-full @lg:w-auto" }, lookupField(h, model)),
				]),
				...(chips.length === 0 ? [] : [hstack(h, { gap: "1.5", wrap: true }, chips)]),
			]),
			panel(
				h,
				{
					className: cn(
						"@container",
						// A failed first load reads like every other failure block: a dashed frame.
						view === null && model.failure !== null && "border-dashed",
						refreshingClass(isWaiting && view !== null),
					),
					attributes: [h.AriaBusy(isWaiting)],
				},
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
