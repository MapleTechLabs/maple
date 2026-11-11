import type { VercelDeploymentSummary } from "@maple/domain/http"
import { ERROR_RATE_TEXT } from "@maple/ui/lib/error-rate"
import { EMPTY_VALUE, formatLatency, formatNumber, formatPercentColumn } from "@maple/ui/lib/format"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { deployLabel, deployTitle } from "../deploy-signals"
import type { VercelProjectRow } from "../list-model"
import {
	COLD_START_HEAVY_PERCENT,
	type ProjectHealth,
	productionDeployOf,
	SLOW_P95_MS,
} from "../overview-model"
import { AppRoute, hrefOf } from "../../../../route"
import { compactSearchInput } from "@maple/views/ui/compact-search-input"
import { badge } from "@maple/views/ui/display"
import { segmentedBar } from "@maple/views/ui/meter"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { filteredEmpty } from "@maple/views/ui/signal-empty-state"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { columnHead, dataTable, NUMERIC_CELL, ROW_LINK_CLASS, skeletonRows } from "../../../kit/data-table"
import type { TimeSearch } from "../../../kit/view-tabs"
import { relativeTime } from "../../../kit/relative-time"
import { type Clock, errorTone, percentText, projectHref } from "../view-parts"
import { Message } from "./model"

// `VercelProjectTable`: every forwarded project, problems first.

type H = HtmlBuilder<Message>

const NAME = "w-0 flex-1 min-w-52"
const DEPLOY = "hidden w-48 min-w-0 lg:flex"
const MIX = "hidden w-28 md:flex"

export const HEALTH_TONE = {
	erroring: "crit",
	failedDeploy: "warn",
	slow: "warn",
	coldStarts: "warn",
	healthy: "ok",
	idle: "neutral",
} as const satisfies Record<ProjectHealth, Tone>

const columns = (h: H): ReadonlyArray<Html> => [
	columnHead(h, { label: "Project", width: NAME }),
	columnHead(h, { label: "Production deploy", width: DEPLOY }),
	columnHead(h, { label: "Requests", width: "w-20", align: "right" }),
	columnHead(h, { label: "Status mix", width: MIX }),
	columnHead(h, { label: "5xx", width: "w-16", align: "right" }),
	columnHead(h, { label: "Cache", width: "w-16", align: "right", hidden: "hidden 2xl:flex" }),
	columnHead(h, { label: "p95", width: "w-16", align: "right" }),
	columnHead(h, { label: "Cold", width: "w-16", align: "right", hidden: "hidden 2xl:flex" }),
]

const deployCell = (h: H, deployment: VercelDeploymentSummary | null, clock: Clock): Html => {
	if (deployment === null)
		return typography(h, { size: "2xs", tone: "muted", className: DEPLOY }, ["no deploys recorded"])
	const failed = Str.toUpperCase(deployment.state) === "ERROR"
	const title = deployTitle(deployment)
	const label = deployLabel(deployment)
	return vstack(h, { gap: "0.5", className: DEPLOY }, [
		hstack(h, { gap: "1.5", className: "min-w-0" }, [
			statusDot(h, { tone: failed ? "crit" : "ok" }),
			typography(
				h,
				{
					size: "2xs",
					tone: "soft",
					mono: title === label,
					truncate: true,
					attributes: [h.Title(`${title} · ${deployment.id}`)],
				},
				[title],
			),
		]),
		hstack(h, { gap: "1", className: "min-w-0 pl-3" }, [
			typography(
				h,
				{ size: "3xs", tone: failed ? "warning" : "muted", mono: true, className: "shrink-0" },
				[`${Str.toLowerCase(deployment.state)} ·`],
			),
			relativeTime(h, {
				value: deployment.createdAt,
				...clock,
				mono: true,
				className: "shrink-0 text-3xs text-muted-foreground",
			}),
			...(title === label
				? []
				: [
						typography(h, { size: "3xs", tone: "muted", mono: true, truncate: true }, [
							`· ${label}`,
						]),
					]),
		]),
	])
}

/** 2xx-ish (everything not 4xx or 5xx), 4xx and 5xx shares, captioned with the share that matters. */
const statusMix = (h: H, row: VercelProjectRow): Html => {
	if (row.requests === 0)
		return typography(h, { size: "2xs", tone: "muted", mono: true, className: MIX }, ["no requests"])
	const other = Math.max(0, row.requests - row.requests4xx - row.requests5xx)
	const tone = errorTone(row.errorPercent)
	return hstack(h, { gap: "2.5", className: MIX }, [
		segmentedBar(h, {
			className: "w-12 shrink-0 gap-px bg-transparent",
			minVisible: 2,
			label: `other ${other}, 4xx ${row.requests4xx}, 5xx ${row.requests5xx}`,
			segments: [
				{ key: "ok", value: other, className: "bg-severity-info" },
				{ key: "4xx", value: row.requests4xx, className: "bg-severity-warn" },
				{ key: "5xx", value: row.requests5xx, className: "bg-severity-error" },
			],
		}),
		tone === "neutral"
			? typography(h, { size: "2xs", tone: "muted", mono: true, numeric: true, truncate: true }, [
					`${formatPercentColumn(row.requests4xx / row.requests)} 4xx`,
				])
			: typography(h, { size: "2xs", tone: "error", mono: true, numeric: true, truncate: true }, [
					`${formatPercentColumn(row.requests5xx / row.requests)} 5xx`,
				]),
	])
}

const numeric = (h: H, width: string, text: string, className: string, title?: string): Html =>
	h.div(
		[h.Class(cn(NUMERIC_CELL, width, className)), ...(title === undefined ? [] : [h.Title(title)])],
		[text],
	)

const row = (h: H, view: VercelProjectRow, health: ProjectHealth, time: TimeSearch, clock: Clock): Html =>
	h.a(
		[h.Key(view.projectId), h.Class(ROW_LINK_CLASS), h.Href(projectHref(view.projectId, time))],
		[
			hstack(h, { gap: "2", className: NAME }, [
				statusDot(h, { tone: HEALTH_TONE[health] }),
				typography(
					h,
					{
						size: "xs",
						tone: "foreground",
						weight: "medium",
						mono: true,
						truncate: true,
						className: "group-hover:text-primary",
						attributes: [h.Title(view.name)],
					},
					[view.name],
				),
				...(view.framework === null
					? []
					: [
							badge(h, { variant: "muted", size: "xs", mono: true, className: "shrink-0" }, [
								view.framework,
							]),
						]),
			]),
			deployCell(h, productionDeployOf(view), clock),
			numeric(
				h,
				"w-20",
				formatNumber(view.requests),
				view.requests === 0 ? "text-muted-foreground" : "text-foreground",
			),
			statusMix(h, view),
			numeric(
				h,
				"w-16",
				view.requests === 0 ? EMPTY_VALUE : formatNumber(view.requests5xx),
				ERROR_RATE_TEXT[errorTone(view.errorPercent)],
			),
			numeric(h, "hidden w-16 2xl:block", percentText(view.cacheHitPercent), "text-foreground-soft"),
			numeric(
				h,
				"w-16",
				view.p95DurationMs === null ? EMPTY_VALUE : formatLatency(view.p95DurationMs),
				view.p95DurationMs === null
					? "text-muted-foreground"
					: view.p95DurationMs >= SLOW_P95_MS
						? "text-severity-warn"
						: "text-foreground-soft",
				view.p95DurationMs === null ? "This project sends no deployment traces" : "Edge request p95",
			),
			numeric(
				h,
				"hidden w-16 2xl:block",
				percentText(view.coldStartPercent),
				view.coldStartPercent !== null && view.coldStartPercent >= COLD_START_HEAVY_PERCENT
					? "text-severity-warn"
					: "text-foreground-soft",
				view.coldStartPercent === null
					? "No function invocations traced"
					: "Cold starts of invocations",
			),
		],
	)

export type ProjectTableInputs = Readonly<{
	rows: ReadonlyArray<Readonly<{ row: VercelProjectRow; health: ProjectHealth }>>
	total: number
	query: string
	isFiltered: boolean
	notForwarded: ReadonlyArray<string>
	time: TimeSearch
	clock: Clock
}>

const header = (h: H, query: string, count: string): Html =>
	panelHeader(h, {
		title: "Projects",
		scope: compactSearchInput(h, {
			value: query,
			placeholder: "Filter projects…",
			ariaLabel: "Filter projects",
			onInput: (value) => Message.ChangedSearch({ value }),
			onClear: Message.ClickedClearSearch(),
			className: "w-56",
		}),
		action: typography(h, { size: "2xs", tone: "muted", mono: true }, [count]),
	})

const footer = (h: H, notForwarded: ReadonlyArray<string>): Html =>
	hstack(h, { gap: "3", justify: "between", className: "border-t px-4 py-2.5" }, [
		typography(h, { size: "2xs", tone: "muted", truncate: true }, [
			notForwarded.length === 0
				? "Every project on the team is forwarded"
				: `${notForwarded.length} ${notForwarded.length === 1 ? "project" : "projects"} not forwarded · ${Arr.join(notForwarded, ", ")}`,
		]),
		typography(h, { size: "2xs", className: "shrink-0" }, [
			textLink(h, { href: hrefOf(AppRoute.Integrations({ search: { integration: "vercel" } })) }, [
				"Manage scope",
			]),
		]),
	])

export const projectTable = (h: H, inputs: ProjectTableInputs): Html =>
	panel(h, {}, [
		header(
			h,
			inputs.query,
			inputs.isFiltered
				? `${inputs.rows.length} of ${inputs.total} projects`
				: `${inputs.total} ${inputs.total === 1 ? "project" : "projects"} · problems first`,
		),
		inputs.rows.length === 0
			? filteredEmpty(h, {
					noun: "projects",
					description: "Clear the filters to see them all.",
					onClear: Message.ClickedClearFilters(),
					clearLabel: "Clear filters",
				})
			: dataTable(
					h,
					{ ariaLabel: "Vercel projects", className: "border-y-0" },
					columns(h),
					Arr.map(inputs.rows, ({ row: view, health }) =>
						row(h, view, health, inputs.time, inputs.clock),
					),
				),
		footer(h, inputs.notForwarded),
	])

export const projectTableLoading = (h: H): Html =>
	panel(h, {}, [
		dataTable(
			h,
			{ ariaLabel: "Vercel projects", isWaiting: true, className: "border-y-0" },
			columns(h),
			skeletonRows(h, 5, () => [
				h.div([h.Class(NAME)], [skeleton(h, "h-4 w-36")]),
				skeleton(h, "hidden h-3 w-32 lg:block"),
				skeleton(h, "h-3 w-20"),
				skeleton(h, "hidden h-1.5 w-28 md:block"),
				skeleton(h, "h-3 w-16"),
				skeleton(h, "hidden h-3 w-16 2xl:block"),
				skeleton(h, "h-3 w-16"),
				skeleton(h, "hidden h-3 w-16 2xl:block"),
			]),
		),
	])
