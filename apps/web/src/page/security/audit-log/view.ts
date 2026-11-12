import { AuditTrailCategory, AuditTrailOutcome, AuditTrailProvider } from "@maple/domain/audit-trail"
import type { AuditTrailEntry } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr, DateTime, Schema } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { compactSearchInput } from "@maple/views/ui/compact-search-input"
import { badge } from "@maple/views/ui/display"
import {
	empty,
	emptyDescription,
	emptyFrameClass,
	emptyHeader,
	emptyMedia,
	emptyTitle,
} from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { keyValue, keyValueList } from "@maple/views/ui/key-value"
import { listFooter } from "@maple/views/ui/list-footer"
import { nativeOption, nativeSelect } from "@maple/views/ui/native-select"
import { panel } from "@maple/views/ui/panel"
import { pressable } from "@maple/views/ui/pressable"
import { filteredEmpty } from "@maple/views/ui/signal-empty-state"
import { hstack, vstack } from "@maple/views/ui/stack"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/views/ui/table"
import { timestamp } from "@maple/views/ui/timestamp"
import { typography } from "@maple/views/ui/typography"
import type { PageViewInputs } from "../../contract"
import { dayKey, dayLabel } from "../../kit/day-label"
import { jsonBlock } from "../../kit/json-block"
import { relativeTime } from "../../kit/relative-time"
import { securityLayout, WIDE_COLUMN } from "../kit/layout"
import { placeholder } from "../kit/parts"
import {
	actorDetail,
	actorText,
	CATEGORY_LABEL,
	categoryLabel,
	eventsOf,
	isFiltered,
	isRefused,
	OUTCOME_LABEL,
	outcomeLabel,
	PROVIDER_LABEL,
	providerLabel,
	targetText,
} from "./derive"
import { canRead, Message, type Model, type SelectFilter } from "./model"
import { nextCursorOf } from "./update"

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const COLUMN_COUNT = 6

// On a phone the two text columns share the width left of the time, so neither scrolls away.
const NARROW_ACTOR = "max-w-32 sm:max-w-56"
const NARROW_ACTION = "max-w-36 sm:max-w-72"

const encodePrettyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

/** One filter as a native select: "All …" clears it. Keyed on its value so a URL change shows. */
const filterSelect = (
	h: H,
	filter: SelectFilter,
	value: string | undefined,
	all: string,
	labels: Readonly<Record<string, string>>,
	values: ReadonlyArray<string>,
): Html =>
	nativeSelect(
		h,
		{
			size: "sm",
			defaultValue: value ?? "",
			attributes: [
				h.Key(`${filter}:${value ?? ""}`),
				h.AriaLabel(all),
				h.OnChange((next) => Message.ChangedFilter({ filter, value: next })),
			],
		},
		[
			nativeOption("", all),
			...Arr.map(values, (option) => nativeOption(option, labels[option] ?? option)),
		],
	)

const toolbar = (h: H, model: Model): Html =>
	hstack(h, { gap: "2", align: "center", wrap: true, className: "border-b px-4 py-2.5" }, [
		// One platform has nothing to choose between; the select appears with the second.
		...(AuditTrailProvider.literals.length > 1
			? [
					filterSelect(
						h,
						"provider",
						model.search.provider,
						"All platforms",
						PROVIDER_LABEL,
						AuditTrailProvider.literals,
					),
				]
			: []),
		filterSelect(
			h,
			"category",
			model.search.category,
			"All categories",
			CATEGORY_LABEL,
			AuditTrailCategory.literals,
		),
		filterSelect(
			h,
			"outcome",
			model.search.outcome,
			"All outcomes",
			OUTCOME_LABEL,
			AuditTrailOutcome.literals,
		),
		compactSearchInput(h, {
			value: model.actorText,
			placeholder: "Actor id or email",
			ariaLabel: "Filter by actor",
			onInput: (value) => Message.ChangedActorText({ value }),
			onClear: Message.ClearedActor(),
			onEnter: Message.SubmittedActor(),
			className: "w-56",
		}),
		...(isFiltered(model.search)
			? [
					button(
						h,
						{
							variant: "ghost",
							size: "sm",
							attributes: [h.OnClick(Message.ClickedClearFilters())],
						},
						["Clear filters"],
					),
				]
			: []),
	])

const outcomeBadge = (h: H, event: AuditTrailEntry): ReadonlyArray<Html> =>
	isRefused(event)
		? [
				badge(h, { variant: "crit", size: "sm", className: "shrink-0" }, [
					icon(h, "CircleXmarkIcon"),
					outcomeLabel(event.outcome),
				]),
			]
		: []

const detailField = (h: H, label: string, value: string | null, mono = false): ReadonlyArray<Html> =>
	value === null ? [] : [keyValue(h, { label, wrap: true, mono }, [value])]

/** Everything the platform said about one event, under its row. */
const eventDetail = (h: H, event: AuditTrailEntry, clock: Clock): Html =>
	vstack(h, { gap: "3", className: "px-4 py-3" }, [
		keyValueList(h, { layout: "grid" }, [
			keyValue(h, { label: "Happened", wrap: true }, [
				timestamp(h, {
					value: isoOf(event.occurredAt),
					...clock,
					withYear: true,
					className: "tabular-nums",
				}),
			]),
			keyValue(h, { label: "Recorded", wrap: true }, [
				timestamp(h, {
					value: isoOf(event.ingestedAt),
					...clock,
					withYear: true,
					className: "tabular-nums",
				}),
			]),
			keyValue(h, { label: "Platform", wrap: true }, [providerLabel(event.provider)]),
			...detailField(h, "Account", event.account),
			keyValue(h, { label: "Category", wrap: true }, [categoryLabel(event.category)]),
			keyValue(h, { label: "Outcome", wrap: true }, [outcomeLabel(event.outcome)]),
			...detailField(h, "Actor id", event.actor.id, true),
			...detailField(h, "Actor email", event.actor.email),
			...detailField(h, "Target type", event.target.type, true),
			...detailField(h, "Target id", event.target.id, true),
			...detailField(h, "Origin IP", event.originIp, true),
			...detailField(h, "Origin country", event.originCountry),
			...detailField(h, "User agent", event.userAgent, true),
			keyValue(h, { label: "Event id", wrap: true, mono: true }, [event.providerEventId]),
		]),
		...(event.raw === null
			? []
			: [
					vstack(h, { gap: "1.5" }, [
						eyebrow(h, { variant: "mono" }, ["Payload"]),
						jsonBlock(h, encodePrettyJson(event.raw)),
					]),
				]),
	])

const isoOf = (epochMs: number): string => DateTime.formatIso(DateTime.makeUnsafe(epochMs))

const eventRows = (h: H, model: Model, event: AuditTrailEntry, clock: Clock): ReadonlyArray<Html> => {
	const isExpanded = Arr.contains(model.expanded, event.id)
	const detailId = `audit-event-${event.id}`
	const actor = actorDetail(event)
	const target = targetText(event)
	return [
		tableRow(
			h,
			[
				tableCell(h, [
					pressable(
						h,
						{
							onClick: Message.ToggledEvent({ id: event.id }),
							label: `${isExpanded ? "Hide" : "Show"} details: ${event.action}`,
							className:
								"focus-visible:ring-ring rounded-sm focus-visible:ring-1 focus-visible:outline-none",
							attributes: [h.AriaExpanded(isExpanded), h.AriaControls(detailId)],
						},
						[
							hstack(h, { gap: "1.5", align: "center", as: "span" }, [
								icon(h, "ChevronRightIcon", {
									size: 12,
									className: cn(
										"text-foreground-subtle shrink-0 transition-transform",
										isExpanded && "rotate-90",
									),
								}),
								relativeTime(h, { value: isoOf(event.occurredAt), ...clock }),
							]),
						],
					),
				]),
				tableCell(h, [providerLabel(event.provider)], WIDE_COLUMN),
				tableCell(
					h,
					[
						vstack(h, { shrink: true }, [
							typography(h, { truncate: true }, [actorText(event)]),
							...(actor === null
								? []
								: [typography(h, { size: "2xs", tone: "muted", truncate: true }, [actor])]),
						]),
					],
					NARROW_ACTOR,
				),
				tableCell(
					h,
					[
						vstack(h, { shrink: true }, [
							typography(h, { mono: true, size: "xs", truncate: true }, [event.action]),
							hstack(h, { gap: "1.5", align: "center", wrap: true }, [
								typography(h, { size: "2xs", tone: "muted" }, [
									categoryLabel(event.category),
								]),
								// A phone has no Outcome column: a refusal still shows, under its action.
								...Arr.map(outcomeBadge(h, event), (mark) =>
									h.span([h.Class("sm:hidden")], [mark]),
								),
							]),
						]),
					],
					NARROW_ACTION,
				),
				tableCell(
					h,
					target === null
						? []
						: [
								typography(h, { mono: true, size: "xs", tone: "muted", truncate: true }, [
									target,
								]),
							],
					WIDE_COLUMN,
				),
				tableCell(h, outcomeBadge(h, event), WIDE_COLUMN),
			],
			isExpanded ? "bg-surface-faint" : undefined,
			[h.Key(event.id)],
		),
		...(isExpanded
			? [
					tableRow(
						h,
						[
							tableCell(h, [eventDetail(h, event, clock)], "p-0 whitespace-normal", [
								h.Attribute("colspan", String(COLUMN_COUNT)),
							]),
						],
						"bg-surface-faint hover:bg-surface-faint active:bg-surface-faint",
						[h.Key(`${event.id}:detail`), h.Id(detailId)],
					),
				]
			: []),
	]
}

/** The rows with a heading wherever the day changes ("Today", "Yesterday", "Mon 2 Nov"). */
const rowsByDay = (
	h: H,
	model: Model,
	events: ReadonlyArray<AuditTrailEntry>,
	clock: Clock,
): ReadonlyArray<Html> =>
	Arr.flatMap(events, (event, index) => {
		const day = dayKey(event.occurredAt, clock.timeZone)
		const previous = events[index - 1]
		const isNewDay = previous === undefined || dayKey(previous.occurredAt, clock.timeZone) !== day
		return [
			...(isNewDay
				? [
						tableRow(
							h,
							[
								tableCell(
									h,
									[
										eyebrow(
											h,
											{ variant: "mono", icon: "CalendarIcon", className: "gap-2" },
											[dayLabel(event.occurredAt, clock)],
										),
									],
									"bg-surface-faint py-1.5",
									[h.Attribute("colspan", String(COLUMN_COUNT))],
								),
							],
							"hover:bg-transparent active:bg-transparent",
							[h.Key(`day-${day}`)],
						),
					]
				: []),
			...eventRows(h, model, event, clock),
		]
	})

const eventsTable = (h: H, model: Model, events: ReadonlyArray<AuditTrailEntry>, clock: Clock): Html =>
	table(h, { ariaLabel: "Audit events" }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, ["Time"], "w-28 sm:w-36"),
				tableHead(h, ["Platform"], WIDE_COLUMN),
				tableHead(h, ["Actor"]),
				tableHead(h, ["Action"]),
				tableHead(h, ["Target"], WIDE_COLUMN),
				tableHead(h, ["Outcome"], cn("w-28", WIDE_COLUMN)),
			]),
		]),
		tableBody(h, rowsByDay(h, model, events, clock)),
	])

const loading = (h: H): ReadonlyArray<Html> => [
	vstack(h, { gap: "4", attributes: [h.AriaBusy(true), h.AriaLabel("Loading")] }, [
		placeholder(h, "h-9 w-full"),
		placeholder(h, "h-80 w-full"),
	]),
]

/** Not an org admin: the page says who can read the log, and loads nothing. */
const adminsOnly = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "LockIcon")]),
				emptyTitle(h, [Policy.denialFor("audit_log:read").message]),
				emptyDescription(h, ["It records who did what, with their email and IP address."]),
			]),
		],
		emptyFrameClass("dashed"),
	)

/** Nothing recorded yet: what will show up, so the first change is not a surprise. */
const noEvents = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "HistoryIcon")]),
				emptyTitle(h, ["No audit events yet"]),
				emptyDescription(h, [
					"Changes made in Maple, and requests it refused, appear here as they happen.",
				]),
			]),
		],
		"py-14",
	)

const listBody = (h: H, model: Model, clock: Clock): Html =>
	AsyncData.matchData(model.firstPage.data, {
		onEmpty: () => vstack(h, { className: "p-4" }, loading(h)),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load the audit log",
				onRetry: Message.ClickedRetry(),
				className: "border-0",
			}),
		onData: () => {
			const events = eventsOf(model) ?? []
			if (events.length === 0 && isFiltered(model.search))
				return filteredEmpty(h, {
					noun: "events",
					description: "Try a wider category or outcome, or another actor.",
					onClear: Message.ClickedClearFilters(),
					className: "py-8",
				})
			if (events.length === 0) return noEvents(h)
			const footer = listFooter(h, {
				shown: events.length,
				noun: "events",
				hasMore: nextCursorOf(model) !== null,
				isLoading: model.laterPages.isFetching,
				isFailed: model.laterPages.isFailed,
				onLoadMore: Message.ClickedLoadMore(),
				className: "border-t",
			})
			return vstack(h, {}, [eventsTable(h, model, events, clock), ...(footer === null ? [] : [footer])])
		},
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const clock = { nowMs: model.nowMs, timeZone: inputs.context.timeZone }
	return securityLayout(
		h,
		{ source: "auditLog" },
		!model.isGrantsRead
			? loading(h)
			: !canRead(model)
				? [adminsOnly(h)]
				: [
						panel(h, { className: "overflow-hidden" }, [
							toolbar(h, model),
							listBody(h, model, clock),
						]),
					],
	)
})
