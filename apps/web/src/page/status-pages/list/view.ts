import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "../../../ui/button"
import { badge } from "../../../ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { skeleton } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { relativeTime } from "../../kit/relative-time"
import { emptyActions } from "../../kit/signal-empty-state"
import { rowLink } from "../../../ui/table"
import { newStatusPageHref, publicAddress, statusPageHref } from "../shared/commands"
import { COMPONENT_STATUS_LABEL, COMPONENT_STATUS_TONE, type StatusPageSummary } from "../shared/derive"
import { Message } from "./message"
import type { Model } from "./model"

// `/status-pages`: the page table, and the builder's on-ramp when there is none.

type H = HtmlBuilder<Message>

type ViewInputs = Readonly<{ isAdmin: boolean; nowMs: number; timeZone: string }>

const ROW_GRID =
	"grid grid-cols-[minmax(220px,1.6fr)_minmax(130px,0.8fr)_96px_112px_128px] items-center gap-x-5"

/** No page yet: what a status page is, and the builder. */
const emptyState = (h: H, isAdmin: boolean): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "WindowChartLineIcon", { size: 18 })]),
				emptyTitle(h, ["No status pages yet"]),
				emptyDescription(h, [
					"A public page that tells your customers what is up. Components follow your uptime monitors, incidents are written by you, and the page stays online when Maple is not.",
				]),
			]),
			...(isAdmin
				? [
						emptyActions(h, [
							linkButton(h, { size: "sm", href: newStatusPageHref() }, [
								icon(h, "PlusIcon"),
								"Create a status page",
							]),
						]),
					]
				: [h.p([h.Class("text-xs text-muted-foreground")], ["Ask an org admin to create one."])]),
		],
		"py-12",
	)

const lastPublished = (h: H, summary: StatusPageSummary, inputs: ViewInputs): Html => {
	const page = summary.page
	if (page.draft) return h.span([h.Class("flex justify-end")], [badge(h, { variant: "meta" }, ["Draft"])])
	if (page.last_publish_error !== null)
		return h.span(
			[h.Class("text-right text-xs text-destructive"), h.Title(page.last_publish_error)],
			["Publish failed"],
		)
	return page.published_at === null
		? h.span([h.Class("text-right text-xs text-muted-foreground")], ["Not published"])
		: relativeTime(h, {
				value: page.published_at,
				nowMs: inputs.nowMs,
				timeZone: inputs.timeZone,
				tooltip: "title",
				className: "text-right text-xs text-muted-foreground",
			})
}

const pageRow = (h: H, summary: StatusPageSummary, inputs: ViewInputs): Html => {
	const page = summary.page
	return h.li(
		[h.Key(page.id), h.Class("relative py-3 pr-4 pl-4 hover:bg-muted/25")],
		[
			h.div(
				[h.Class(ROW_GRID)],
				[
					h.div(
						[h.Class("min-w-0")],
						[
							rowLink(
								h,
								{
									href: statusPageHref(page.id),
									className: "block truncate text-sm font-medium",
								},
								[page.name],
							),
							h.p(
								[h.Class("truncate font-mono text-xs text-muted-foreground")],
								[publicAddress(page.slug)],
							),
						],
					),
					h.span(
						[],
						[
							summary.componentCount === 0
								? h.span([h.Class("text-xs text-muted-foreground")], ["No components"])
								: badge(h, { variant: COMPONENT_STATUS_TONE[summary.overall] }, [
										COMPONENT_STATUS_LABEL[summary.overall],
									]),
						],
					),
					h.span(
						[h.Class("text-right font-mono text-xs tabular-nums text-muted-foreground")],
						[String(summary.componentCount)],
					),
					h.span(
						[
							h.Class(
								cn(
									"text-right font-mono text-xs tabular-nums",
									summary.openIncidents > 0
										? "text-severity-warn"
										: "text-muted-foreground",
								),
							),
						],
						[String(summary.openIncidents)],
					),
					lastPublished(h, summary, inputs),
				],
			),
		],
	)
}

const table = (h: H, pages: ReadonlyArray<StatusPageSummary>, inputs: ViewInputs): Html =>
	h.div(
		[h.Class("overflow-x-auto rounded-md border")],
		[
			h.div(
				[h.Class("min-w-[720px]")],
				[
					h.div(
						[h.Class(cn(ROW_GRID, "border-b py-2 pr-4 pl-4"))],
						[
							eyebrow(h, {}, ["Page"]),
							eyebrow(h, {}, ["Status"]),
							eyebrow(h, { className: "text-right" }, ["Components"]),
							eyebrow(h, { className: "text-right" }, ["Open incidents"]),
							eyebrow(h, { className: "text-right" }, ["Last published"]),
						],
					),
					h.ul(
						[h.Class("divide-y")],
						pages.map((summary) => pageRow(h, summary, inputs)),
					),
				],
			),
		],
	)

const body = (h: H, model: Model, inputs: ViewInputs): Html => {
	const data = model.pages.data
	if (AsyncData.isFailure(data))
		return errorState(h, {
			failure: data.error,
			title: "Couldn't load status pages",
			onRetry: Message.ClickedRetry(),
			className: "py-12",
		})
	return Option.match(AsyncData.getData(data), {
		onNone: () =>
			h.div([h.Class("flex flex-col gap-4")], [skeleton(h, "h-9 w-1/3"), skeleton(h, "h-48 w-full")]),
		onSome: (pages) =>
			pages.length === 0
				? emptyState(h, inputs.isAdmin)
				: h.div(
						[h.Class("flex flex-col gap-3")],
						[
							h.p(
								[h.Class("text-xs text-muted-foreground")],
								[
									`${countLabel(pages.length, "page")}. Each one is served from edge storage, so it stays up when Maple does not.`,
								],
							),
							table(h, pages, inputs),
						],
					),
	})
}

const hasPages = (model: Model): boolean =>
	Option.match(AsyncData.getData(model.pages.data), {
		onNone: () => false,
		onSome: (pages) => pages.length > 0,
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	dashboardPage(
		h,
		{
			title: "Status pages",
			actions:
				model.isAdmin && hasPages(model)
					? linkButton(h, { size: "sm", href: newStatusPageHref() }, [
							icon(h, "PlusIcon"),
							"New status page",
						])
					: undefined,
		},
		[
			body(h, model, {
				isAdmin: model.isAdmin,
				nowMs: model.nowMs ?? 0,
				timeZone: inputs.context.timeZone,
			}),
		],
	),
)
