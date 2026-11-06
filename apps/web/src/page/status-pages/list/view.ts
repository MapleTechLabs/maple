import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Option, Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { skeleton } from "@maple/views/ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { relativeTime } from "../../kit/relative-time"
import { emptyActions } from "@maple/views/ui/signal-empty-state"
import { rowLink } from "@maple/views/ui/table"
import { newStatusPageHref, publicAddress, statusPageHref } from "../shared/commands"
import { COMPONENT_STATUS_LABEL, COMPONENT_STATUS_TONE, type StatusPageSummary } from "../shared/derive"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { vstack } from "@maple/views/ui/stack"
import { borderedBox } from "@maple/views/ui/bordered-box"

// `/status-pages`: the page table, and the builder's on-ramp when there is none.

type H = HtmlBuilder<Message>

type ViewInputs = Readonly<{ canEdit: boolean; nowMs: number; timeZone: string }>

const ROW_GRID =
	"grid grid-cols-[minmax(220px,1.6fr)_minmax(130px,0.8fr)_96px_112px_128px] items-center gap-x-5"

/** No page yet: what a status page is, and the builder. */
const emptyState = (h: H, canEdit: boolean): Html =>
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
			...(canEdit
				? [
						emptyActions(h, [
							linkButton(h, { size: "sm", href: newStatusPageHref() }, [
								icon(h, "PlusIcon"),
								"Create a status page",
							]),
						]),
					]
				: [
						typography(h, { size: "xs", tone: "muted", as: "p" }, [
							"Ask an org admin to create one.",
						]),
					]),
		],
		"py-12",
	)

const lastPublished = (h: H, summary: StatusPageSummary, inputs: ViewInputs): Html => {
	const page = summary.page
	if (page.draft) return h.span([h.Class("flex justify-end")], [badge(h, { variant: "meta" }, ["Draft"])])
	if (page.last_publish_error !== null)
		return h.span(
			[h.Class("text-right text-xs text-destructive-foreground"), h.Title(page.last_publish_error)],
			["Publish failed"],
		)
	return page.published_at === null
		? typography(h, { size: "xs", tone: "muted", className: "text-right" }, ["Not published"])
		: relativeTime(h, {
				value: page.published_at,
				nowMs: inputs.nowMs,
				timeZone: inputs.timeZone,
				className: typographyClass({ size: "xs", tone: "muted", className: "text-right" }),
			})
}

const pageRow = (h: H, summary: StatusPageSummary, inputs: ViewInputs): Html => {
	const page = summary.page
	return h.li(
		[h.Key(page.id), h.Class("relative py-3 pr-4 pl-4 hover:bg-surface-sunken active:bg-surface-sunken")],
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
							typography(
								h,
								{ size: "xs", tone: "muted", mono: true, truncate: true, as: "p" },
								[publicAddress(page.slug)],
							),
						],
					),
					h.span(
						[],
						[
							summary.componentCount === 0
								? typography(h, { size: "xs", tone: "muted" }, ["No components"])
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
									typographyClass({
										size: "xs",
										mono: true,
										numeric: true,
										className: "text-right",
									}),
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
	borderedBox(h, { overflow: "x-auto" }, [
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
					Arr.map(pages, (summary) => pageRow(h, summary, inputs)),
				),
			],
		),
	])

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
		onNone: () => vstack(h, { gap: "4" }, [skeleton(h, "h-9 w-1/3"), skeleton(h, "h-48 w-full")]),
		onSome: (pages) =>
			pages.length === 0
				? emptyState(h, inputs.canEdit)
				: vstack(h, { gap: "3" }, [
						typography(h, { size: "xs", tone: "muted", as: "p" }, [
							`${countLabel(pages.length, "page")}. Each one is served from edge storage, so it stays up when Maple does not.`,
						]),
						table(h, pages, inputs),
					]),
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
				canManage(model) && hasPages(model)
					? linkButton(h, { size: "sm", href: newStatusPageHref() }, [
							icon(h, "PlusIcon"),
							"New status page",
						])
					: undefined,
		},
		[
			body(h, model, {
				canEdit: canManage(model),
				nowMs: model.nowMs ?? 0,
				timeZone: inputs.context.timeZone,
			}),
		],
	),
)
