import { errorRateClass, errorRateLevel } from "@maple/ui/lib/error-rate"
import { formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { textLink } from "@maple/views/ui/text-link"
import { emptyMessage } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { panel } from "@maple/views/ui/panel"
import { skeleton, skeletonList } from "@maple/views/ui/skeleton"
import { statusDot } from "@maple/views/ui/status-dot"
import { latencyValue } from "@maple/views/ui/values"
import { relativeTime } from "../../../kit/relative-time"
import { sectionHeading } from "../../../kit/section-heading"
import type { EventEntry, QueryInsights } from "../data"
import { presentEvent } from "./derive"
import { Message } from "./model"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

// The Activity feed and Top queries sections of `PlanetScaleDatabaseData`.

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const activityRow = (h: H, event: EventEntry, clock: Clock): Html => {
	const presentation = presentEvent(event.eventType)
	return hstack(
		h,
		{
			gap: "2.5",
			align: "baseline",
			as: "li",
			className: "border-l border-border-subtle py-1.5 pl-3 text-xs",
		},
		[
			statusDot(h, { tone: presentation.tone, className: "mt-1" }),
			h.span(
				[h.Class("min-w-0 flex-1 truncate text-foreground-soft"), h.Title(event.title)],
				[event.title],
			),
			...(event.branchName === ""
				? []
				: [
						textLink(
							h,
							{
								onClick: Message.SelectedBranch({ branch: event.branchName }),
								tone: "muted",
								isMono: true,
								className: "block min-w-0 max-w-[40%] truncate text-2xs",
								attributes: [h.Title(event.branchName)],
							},
							[event.branchName],
						),
					]),
			...(event.actorLogin === null
				? []
				: [
						h.span(
							[h.Class("hidden shrink-0 text-2xs text-muted-foreground sm:inline")],
							[event.actorLogin],
						),
					]),
			...(event.url === null
				? []
				: [
						h.a(
							[
								h.AriaLabel("Open in PlanetScale"),
								h.Class(
									typographyClass({
										tone: "muted",
										hoverTone: "foreground",
										className: "shrink-0",
									}),
								),
								h.Href(event.url),
								h.Rel("noreferrer"),
								h.Target("_blank"),
							],
							[icon(h, "ExternalLinkIcon", { size: 12 })],
						),
					]),
			relativeTime(h, {
				value: event.occurredAt,
				...clock,
				className: typographyClass({ tone: "muted", numeric: true, className: "shrink-0" }),
			}),
		],
	)
}

const activityLoading = (h: H): Html =>
	vstack(
		h,
		{ as: "ul" },
		Array.from({ length: 4 }, (_, index) =>
			h.li(
				[h.Class("border-l border-border-subtle py-1.5 pl-3")],
				[skeleton(h, cn("h-3", index % 2 === 0 ? "w-64" : "w-48"))],
			),
		),
	)

export const activitySection = (
	h: H,
	slot: AsyncData.AsyncData<ReadonlyArray<EventEntry>, unknown>,
	clock: Clock,
): Html => {
	const events = AsyncData.isSuccess(slot) || AsyncData.isRefreshing(slot) ? slot.data : []
	const isWaiting = AsyncData.isRefreshing(slot)
	const body =
		AsyncData.isIdle(slot) || AsyncData.isLoading(slot)
			? activityLoading(h)
			: AsyncData.isFailure(slot) || AsyncData.isStale(slot)
				? typography(h, { size: "xs", tone: "muted", as: "p", className: "py-2" }, [
						"Couldn't load the deploy timeline for this window.",
					])
				: events.length === 0
					? h.p(
							[h.Class("py-3 text-xs text-muted-foreground")],
							["No deploys or branch events in this window."],
						)
					: h.ul(
							[
								h.Class(cn("flex flex-col", refreshingClass(isWaiting))),
								...(isWaiting ? [h.AriaBusy(true)] : []),
							],
							Arr.map(events, (event) => activityRow(h, event, clock)),
						)
	return h.section(
		[h.Class("space-y-2")],
		[
			sectionHeading(h, {
				title: "Activity",
				actions: typography(h, { size: "2xs", tone: "muted", mono: true }, [String(events.length)]),
			}),
			body,
		],
	)
}

const insightsNotice = (h: H, children: ReadonlyArray<Html | string>): Html =>
	emptyMessage(h, { dashed: true, className: "bg-surface-faint px-3 py-4 text-xs" }, children)

/** `PlanetScaleTopQueries`. */
export const topQueries = (
	h: H,
	slot: AsyncData.AsyncData<QueryInsights, Parameters<typeof errorState>[1]["failure"]>,
	database: string,
	clock: Clock,
): Html =>
	AsyncData.match(slot, {
		onIdle: () => skeletonList(h, { rows: 3, rowClassName: "h-[52px] rounded-md", className: "gap-1.5" }),
		onLoading: () =>
			skeletonList(h, { rows: 3, rowClassName: "h-[52px] rounded-md", className: "gap-1.5" }),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "PlanetScale Query Insights are unavailable",
				variant: "inline",
			}),
		onStale: ({ error }) =>
			errorState(h, {
				failure: error,
				title: "PlanetScale Query Insights are unavailable",
				variant: "inline",
			}),
		onRefreshing: (response) => insightsList(h, response, database, clock),
		onSuccess: (response) => insightsList(h, response, database, clock),
	})

const insightsList = (h: H, response: QueryInsights, database: string, clock: Clock): Html => {
	if (response.unavailableReason !== null && response.unavailableReason !== "") {
		return insightsNotice(h, [response.unavailableReason])
	}
	if (response.rows.length === 0) {
		return insightsNotice(h, [
			"No queries recorded on",
			" ",
			typography(h, { tone: "soft", mono: true }, [database, "/", response.branch]),
			" ",
			"in this window.",
		])
	}
	return h.div(
		[h.Class("space-y-1.5")],
		Arr.map(response.rows, (row) =>
			panel(h, { className: "px-2.5 py-2" }, [
				hstack(h, { gap: "2", align: "start", justify: "between" }, [
					h.p(
						[
							h.Class("min-w-0 flex-1 truncate font-mono text-2xs font-medium text-foreground"),
							h.Title(row.normalizedSql),
						],
						[row.normalizedSql],
					),
					h.span(
						[
							h.Class(
								cn(
									"shrink-0 font-mono text-3xs tabular-nums",
									errorRateLevel(row.errorRate) === "neutral"
										? "text-muted-foreground"
										: errorRateClass(row.errorRate),
								),
							),
						],
						[formatErrorRate(row.errorRate)],
					),
				]),
				hstack(
					h,
					{
						align: "center",
						wrap: true,
						className: "mt-1.5 gap-x-3 gap-y-1 text-3xs text-muted-foreground",
					},
					[
						typography(h, { mono: true, numeric: true }, [
							formatNumber(row.queryCount),
							" calls",
						]),
						typography(h, { mono: true, numeric: true }, [
							"p50 ",
							latencyValue(h, {
								ms: row.p50LatencyMillis,
								scale: "p50",
								className: "text-3xs",
							}),
						]),
						typography(h, { mono: true, numeric: true }, [
							"p99 ",
							latencyValue(h, {
								ms: row.p99LatencyMillis,
								scale: "p99",
								className: "text-3xs",
							}),
						]),
						typography(h, { mono: true, numeric: true }, [
							formatNumber(row.rowsReadPerQuery),
							" rows read/query",
						]),
						...(row.statementType ? [h.span([h.Class("uppercase")], [row.statementType])] : []),
						...(row.lastRunAt === null
							? []
							: [
									relativeTime(h, {
										value: row.lastRunAt,
										...clock,
										prefix: "last run",
										mono: true,
										className: "ml-auto text-foreground-subtle",
									}),
								]),
					],
				),
			]),
		),
	)
}
