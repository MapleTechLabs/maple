import { AuditTrailCategory } from "@maple/domain/audit-trail"
import type { AuditTrailEntry } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { formatTimestampInTimezone } from "@maple/ui/lib/timezone-format"
import * as Keyed from "@maple/views/data/keyed"
import { Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { compactSearchInput } from "@maple/views/ui/compact-search-input"
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
import {
	table,
	tableBody,
	tableCell,
	tableGroupRow,
	tableHead,
	tableHeader,
	tableRow,
} from "@maple/views/ui/table"
import { textLink } from "@maple/views/ui/text-link"
import { timestamp } from "@maple/views/ui/timestamp"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { AppRoute, hrefOf } from "../../../route"
import type { PageViewInputs } from "../../contract"
import { dayEyebrow, dayKey } from "../../kit/day-label"
import { expandChevron } from "../../kit/expand-chevron"
import { jsonBlock, prettyJson } from "../../kit/json-block"
import { refusedBadge } from "../../kit/refused-badge"
import { relativeTime } from "../../kit/relative-time"
import { securityLayout, WIDE_COLUMN } from "../kit/layout"
import { placeholderRows } from "../kit/parts"
import {
	actorDetail,
	actorText,
	actorTypeLabel,
	CATEGORY_LABEL,
	categoryLabel,
	eventsOf,
	isFiltered,
	isForbidden,
	isMarked,
	labelIn,
	nextCursorOf,
	OUTCOME_FILTERS,
	OUTCOME_LABEL,
	outcomeLabel,
	targetText,
} from "./derive"
import { accessOf, Message, type Model, type SelectFilter } from "./model"

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const COLUMN_COUNT = 5

// On a phone the two text columns share the width left of the time, so neither scrolls away.
const NARROW_ACTOR = "max-w-32 sm:max-w-56"
const NARROW_ACTION = "max-w-36 sm:max-w-72"

/** One filter as a native select: "All …" clears it. The URL holds the value it shows. */
const filterSelect = (
	h: H,
	filter: SelectFilter,
	/** What the select filters, as a screen reader names it. */
	name: string,
	value: string | undefined,
	all: string,
	labels: Readonly<Record<string, string>>,
	values: ReadonlyArray<string>,
): Html =>
	nativeSelect(
		h,
		{
			size: "sm",
			value: value ?? "",
			attributes: [
				h.AriaLabel(name),
				h.OnChange((next) => Message.ChangedFilter({ filter, value: next })),
			],
		},
		[
			nativeOption("", all),
			...Arr.map(values, (option) => nativeOption(option, labelIn(labels, option))),
		],
	)

const toolbar = (h: H, model: Model): Html =>
	hstack(h, { gap: "2", align: "center", wrap: true, className: "border-b px-4 py-2.5" }, [
		filterSelect(
			h,
			"category",
			"Category",
			model.search.category,
			"All categories",
			CATEGORY_LABEL,
			AuditTrailCategory.literals,
		),
		filterSelect(
			h,
			"outcome",
			"Outcome",
			model.search.outcome,
			"All outcomes",
			OUTCOME_LABEL,
			OUTCOME_FILTERS,
		),
		compactSearchInput(h, {
			value: model.actorText,
			placeholder: "Actor id or email, then Enter",
			ariaLabel: "Filter by actor",
			onInput: (value) => Message.ChangedActorText({ value }),
			onClear: Message.ClearedActor(),
			onEnter: Message.SubmittedActor(),
			className: "w-64",
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

const outcomeMark = (h: H, event: AuditTrailEntry): ReadonlyArray<Html> =>
	isMarked(event) ? [refusedBadge(h, outcomeLabel(event.outcome))] : []

const detailField = (h: H, label: string, value: string | null, mono = false): ReadonlyArray<Html> =>
	value === null ? [] : [keyValue(h, { label, wrap: true, mono }, [value])]

/** Everything recorded about one event, under its row: nothing the row cut off is lost. */
const eventDetail = (h: H, event: AuditTrailEntry, clock: Clock): Html => {
	const at = (value: number) => timestamp(h, { value, ...clock, withYear: true, className: "tabular-nums" })
	return vstack(h, { gap: "3", className: "px-4 py-3" }, [
		keyValueList(h, { layout: "grid" }, [
			keyValue(h, { label: "Action", wrap: true, mono: true }, [event.action]),
			keyValue(h, { label: "Category", wrap: true }, [categoryLabel(event.category)]),
			keyValue(h, { label: "Outcome", wrap: true }, [outcomeLabel(event.outcome)]),
			...detailField(h, "Reason", event.outcomeReason),
			...detailField(h, "Actor", event.actor.name),
			keyValue(h, { label: "Actor type", wrap: true }, [actorTypeLabel(event.actor.type)]),
			...detailField(h, "Actor id", event.actor.id, true),
			...detailField(h, "Actor email", event.actor.email),
			...detailField(h, "Target", event.target.name),
			...detailField(h, "Target type", event.target.type, true),
			...detailField(h, "Target id", event.target.id, true),
			...detailField(h, "IP address", event.originIp, true),
			...detailField(h, "Country", event.originCountry),
			...detailField(h, "User agent", event.userAgent, true),
			...detailField(h, "Account", event.account, true),
			keyValue(h, { label: "Occurred", wrap: true }, [at(event.occurredAt)]),
			keyValue(h, { label: "Recorded", wrap: true }, [at(event.ingestedAt)]),
			keyValue(h, { label: "Event id", wrap: true, mono: true }, [event.providerEventId]),
		]),
		...(event.raw === null
			? []
			: [
					vstack(h, { gap: "1.5" }, [
						eyebrow(h, { variant: "mono" }, ["Payload"]),
						jsonBlock(h, prettyJson(event.raw)),
					]),
				]),
	])
}

const eventRows = (h: H, model: Model, event: AuditTrailEntry, clock: Clock): ReadonlyArray<Html> => {
	const isExpanded = Arr.contains(model.expanded, event.id)
	const detailId = `audit-event-${event.id}`
	const actor = actorDetail(event)
	const target = targetText(event)
	const small = typographyClass({ size: "2xs", tone: "muted" })
	return [
		tableRow(
			h,
			[
				tableCell(
					h,
					[
						// The whole cell, so a thumb has more than a line of text to hit. Its label
						// replaces its content for a screen reader, so it says when as well as what.
						pressable(
							h,
							{
								onClick: Message.ToggledEvent({ id: event.id }),
								label: `${isExpanded ? "Hide" : "Show"} details: ${event.action}, ${formatTimestampInTimezone(event.occurredAt, { timeZone: clock.timeZone, withYear: true })}`,
								className:
									"focus-visible:ring-ring flex min-h-10 w-full items-center gap-1.5 px-2.5 focus-visible:ring-1 focus-visible:outline-none focus-visible:ring-inset",
								attributes: [h.AriaExpanded(isExpanded), h.AriaControls(detailId)],
							},
							[
								expandChevron(h, isExpanded),
								relativeTime(h, { value: event.occurredAt, ...clock, variant: "short" }),
							],
						),
					],
					"p-0",
				),
				tableCell(
					h,
					[
						vstack(h, { shrink: true }, [
							truncatedText(h, { text: actorText(event), tooltip: "overflow" }),
							...(actor === null
								? []
								: [truncatedText(h, { text: actor, tooltip: "overflow", className: small })]),
						]),
					],
					NARROW_ACTOR,
				),
				tableCell(
					h,
					[
						vstack(h, { shrink: true }, [
							truncatedText(h, {
								text: event.action,
								mono: true,
								tooltip: "overflow",
								className: typographyClass({ size: "xs" }),
							}),
							hstack(h, { gap: "1.5", align: "center", wrap: true }, [
								typography(h, { size: "2xs", tone: "muted" }, [
									categoryLabel(event.category),
								]),
								// A phone has no Outcome column: the mark still shows, under its action.
								...Arr.map(outcomeMark(h, event), (mark) =>
									h.span([h.Class("sm:hidden")], [mark]),
								),
							]),
							...(event.outcomeReason === null
								? []
								: [
										truncatedText(h, {
											text: event.outcomeReason,
											tooltip: "overflow",
											className: small,
										}),
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
								truncatedText(h, {
									text: target,
									mono: true,
									tooltip: "overflow",
									className: typographyClass({ size: "xs", tone: "muted" }),
								}),
							],
					`max-w-64 ${WIDE_COLUMN}`,
				),
				tableCell(h, outcomeMark(h, event), WIDE_COLUMN),
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
						tableGroupRow(h, { colSpan: COLUMN_COUNT, key: `day-${day}` }, [
							dayEyebrow(h, event.occurredAt, clock),
						]),
					]
				: []),
			...eventRows(h, model, event, clock),
		]
	})

const eventsTable = (h: H, model: Model, events: ReadonlyArray<AuditTrailEntry>, clock: Clock): Html =>
	table(h, { ariaLabel: "Audit events" }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, ["Time"], "w-24"),
				tableHead(h, ["Actor"]),
				tableHead(h, ["Action"]),
				tableHead(h, ["Target"], WIDE_COLUMN),
				tableHead(h, ["Outcome"], `w-28 ${WIDE_COLUMN}`),
			]),
		]),
		tableBody(h, rowsByDay(h, model, events, clock)),
	])

/** Not an org admin: the page says who can read the log. */
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
		onEmpty: () => placeholderRows(h, 6),
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
			// While other filters load, the rows on screen are the old answer and cannot be extended.
			const canExtend = Keyed.canExtend(model.firstPage)
			const footer = listFooter(h, {
				shown: events.length,
				noun: "events",
				hasMore: canExtend && nextCursorOf(model) !== null,
				isLoading: model.laterPages.isFetching,
				isFailed: canExtend && model.laterPages.isFailed,
				onLoadMore: Message.ClickedLoadMore(),
				className: "border-t",
			})
			const isRefetching = Keyed.isInFlight(model.firstPage)
			return vstack(
				h,
				{ className: refreshingClass(isRefetching), attributes: [h.AriaBusy(isRefetching)] },
				[eventsTable(h, model, events, clock), ...(footer === null ? [] : [footer])],
			)
		},
	})

/** Allowed reads are not here, and a reader should not take their absence for "nobody read". */
const footnote = (h: H): Html =>
	typography(h, { size: "xs", tone: "muted", as: "p" }, [
		"Allowed reads, tool calls and SQL runs are not listed here. They are in ",
		textLink(
			h,
			{
				tone: "muted",
				className: "underline",
				href: hrefOf(AppRoute.Settings({ search: { tab: "audit-log" } })),
			},
			["Settings, Audit log"],
		),
		".",
	])

/** The session, or the API when the session could not say, refused the viewer. */
const isRefused = (model: Model): boolean =>
	accessOf(model) === "denied" ||
	AsyncData.matchData(model.firstPage.data, {
		onEmpty: () => false,
		onFailure: isForbidden,
		onData: () => false,
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const clock = { nowMs: model.nowMs, timeZone: inputs.context.timeZone }
	return securityLayout(
		h,
		{ source: "auditLog" },
		accessOf(model) === "unknown"
			? [placeholderRows(h, 6)]
			: isRefused(model)
				? [adminsOnly(h)]
				: [
						panel(h, { className: "overflow-hidden" }, [
							toolbar(h, model),
							listBody(h, model, clock),
						]),
						footnote(h),
					],
	)
})
