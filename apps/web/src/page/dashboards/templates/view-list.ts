import type { V2DashboardTemplate } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { pressable } from "../../../ui/pressable"
import { segmentedSelect } from "../../../ui/segmented-select"
import { skeletonList } from "../../../ui/skeleton"
import { truncatedText } from "../../../ui/truncated-text"
import { listSectionHeader, toolbarSearch } from "../kit/list-parts"
import {
	BLANK_TEMPLATE_ID,
	CATEGORY_LABELS,
	CATEGORY_ORDER,
	type TemplateReadiness,
	templateIcon,
	templateMatches,
	widgetCountLabel,
} from "./derive"
import { Message } from "./message"
import type { Model, ReadinessFilter } from "./model"
import { filteredEmpty as filteredEmptyState } from "../../kit/signal-empty-state"

// `TemplateList`: the templates as rows.

type H = HtmlBuilder<Message>

const READINESS_OPTIONS = [
	{ value: "all", label: "All" },
	{ value: "ready", label: "Ready" },
	{ value: "needs-setup", label: "Needs setup" },
] as const

/** `TemplateRow`: fixed-width lanes so names, counts and statuses form columns. */
const templateRow = (
	h: H,
	template: V2DashboardTemplate,
	readiness: TemplateReadiness | undefined,
	isSelected: boolean,
): Html => {
	const status = readiness?.missingLabel ?? null
	return pressable(
		h,
		{
			onClick: Message.ClickedTemplate({ templateId: template.id }),
			selectedLane: isSelected,
			className: cn(
				"flex min-h-9 w-full items-center text-left transition-colors",
				!isSelected && "hover:bg-surface-sunken active:bg-surface-sunken",
			),
			attributes: [h.Key(template.id), ...(isSelected ? [h.AriaCurrent("true")] : [])],
		},
		[
			h.span(
				[h.Class("flex min-w-0 grow items-center gap-2.5 py-2 pr-4 pl-4")],
				[
					h.span(
						[
							h.Class(
								cn(
									"flex size-5.5 shrink-0 items-center justify-center rounded-sm border border-border",
									isSelected ? "bg-background" : "bg-card",
								),
							),
						],
						[
							icon(h, templateIcon(template.id, template.category), {
								size: 12,
								className: status !== null ? "text-muted-foreground" : "text-foreground",
							}),
						],
					),
					h.span(
						[
							h.Class(
								cn(
									"min-w-0 grow truncate text-sm",
									isSelected ? "font-medium text-foreground" : "text-foreground",
								),
							),
						],
						[template.name],
					),
					...(status === null
						? []
						: [
								truncatedText(h, {
									text: status,
									mono: true,
									className:
										"text-foreground-subtle max-w-31.5 shrink-0 text-right text-2xs",
								}),
							]),
					// Last, so every count lines up on the list's right edge.
					h.span(
						[h.Class("text-muted-foreground w-18 shrink-0 text-right font-mono text-2xs")],
						[widgetCountLabel(template)],
					),
				],
			),
		],
	)
}

const filteredEmpty = (h: H, query: string): Html =>
	filteredEmptyState(h, {
		noun: "templates",
		title: `No template matches “${query.trim()}”`,
		description: "Try a shorter term. Or start blank and add the widgets you want.",
		icon: icon(h, "MagnifierIcon", { size: 16 }),
		onClear: Message.ChangedSearchDraft({ value: "" }),
		clearLabel: "Clear search",
		className: "py-14",
	})

const filterHidEverything = (h: H, filter: ReadinessFilter, matched: number, isSearching: boolean): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [
					icon(h, filter === "ready" ? "CircleWarningIcon" : "CircleCheckIcon", { size: 16 }),
				]),
				emptyTitle(h, [
					filter === "ready" ? "None of these are ready yet" : "These are all ready to use",
				]),
				emptyDescription(h, [
					matched === 1 ? "The one template" : `All ${matched} templates`,
					" ",
					isSearching ? "matching your search" : "here",
					" ",
					filter === "ready"
						? matched === 1
							? "still needs setup."
							: "still need setup."
						: "can already draw your data.",
				]),
			]),
			button(
				h,
				{
					variant: "outline",
					size: "sm",
					attributes: [h.OnClick(Message.ChangedFilter({ filter: "all" }))],
				},
				["Show all templates"],
			),
		],
		"py-14",
	)

/** The ready group, then the gated ones by category. */
const groups = (
	h: H,
	model: Model,
	ready: ReadonlyArray<V2DashboardTemplate>,
	needsSetup: ReadonlyArray<V2DashboardTemplate>,
	readiness: ReadonlyMap<string, TemplateReadiness>,
	isReadinessKnown: boolean,
): ReadonlyArray<Html> => {
	const row = (template: V2DashboardTemplate) =>
		templateRow(h, template, readiness.get(template.id), template.id === model.search.template)
	const byCategory = CATEGORY_ORDER.map((category) => ({
		category,
		templates: needsSetup.filter((template) => template.category === category),
	})).filter((group) => group.templates.length > 0)
	return [
		...(ready.length === 0
			? []
			: [
					// Until the data check answers, nothing is known to be ready: just count the templates.
					listSectionHeader(h, {
						title: isReadinessKnown ? "Ready for your data" : "Templates",
						count: ready.length,
						accent: isReadinessKnown,
						className: "px-4 pt-4",
					}),
					...ready.map(row),
				]),
		...(needsSetup.length === 0
			? []
			: [
					listSectionHeader(h, {
						title: "Needs setup",
						count: needsSetup.length,
						note: "these would render empty today",
						className: cn("px-4 pt-4", ready.length > 0 && "mt-2 border-t border-border pt-6"),
					}),
					...byCategory.map(({ category, templates }) =>
						h.keyed("div")(
							category,
							[],
							[
								h.div(
									[h.Class("text-foreground-subtle pt-3.5 pr-4 pb-1 pl-12.5 text-2xs")],
									[CATEGORY_LABELS.get(category) ?? category],
								),
								...templates.map(row),
							],
						),
					),
				]),
	]
}

export const templateList = (
	h: H,
	model: Model,
	readiness: ReadonlyMap<string, TemplateReadiness>,
	isReadinessKnown: boolean,
): Html => {
	const isLoading =
		!AsyncData.isSuccess(model.templates.data) && !AsyncData.isRefreshing(model.templates.data)
	const listed =
		model.templates.data._tag === "Success" || model.templates.data._tag === "Refreshing"
			? model.templates.data.data.filter((template) => template.id !== BLANK_TEMPLATE_ID)
			: []
	const searched = listed.filter((template) => templateMatches(template, model.query))
	const isReady = (template: V2DashboardTemplate) => readiness.get(template.id)?.ready !== false
	const ready = model.filter === "needs-setup" ? [] : searched.filter(isReady)
	const needsSetup = model.filter === "ready" ? [] : searched.filter((template) => !isReady(template))
	const isSearching = model.query.trim().length > 0
	const isNothingMatched = !isLoading && searched.length === 0
	const isFilterHidingAll = !isLoading && searched.length > 0 && ready.length + needsSetup.length === 0
	return h.div(
		[h.Class("flex min-h-0 flex-col overflow-hidden")],
		[
			h.div(
				[
					h.Class(
						cn(
							"flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3",
							"shrink-0 flex-nowrap gap-2.5",
						),
					),
				],
				[
					toolbarSearch(h, {
						id: "templates-search",
						draft: model.searchDraft,
						placeholder: "Search templates…",
						className: "min-w-0 grow",
						onInput: (value) => Message.ChangedSearchDraft({ value }),
					}),
					segmentedSelect<ReadinessFilter, Message>(h, {
						options: READINESS_OPTIONS,
						value: model.filter,
						onChange: (filter) => Message.ChangedFilter({ filter }),
						ariaLabel: "Filter templates by readiness",
						size: "sm",
						className: "shrink-0",
					}),
				],
			),
			...(isSearching && !isLoading
				? [
						h.div(
							[
								h.Class(
									"flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-2xs",
								),
							],
							[
								h.span([h.Class("font-mono text-foreground")], [String(searched.length)]),
								h.span(
									[h.Class("text-muted-foreground")],
									["of ", String(listed.length), " match name, description or tag"],
								),
							],
						),
					]
				: []),
			h.div(
				[h.Class("min-h-0 grow overflow-y-auto")],
				isLoading
					? [
							skeletonList(h, {
								rows: 8,
								rowClassName: "h-7 rounded-sm",
								gap: "2",
								className: "p-4",
							}),
						]
					: isNothingMatched
						? [filteredEmpty(h, model.query)]
						: isFilterHidingAll
							? [filterHidEverything(h, model.filter, searched.length, isSearching)]
							: [
									...groups(h, model, ready, needsSetup, readiness, isReadinessKnown),
									// Pads the list by its own height and fades rows into the footer as they scroll under.
									h.div(
										[
											h.AriaHidden(true),
											h.Class(
												"pointer-events-none sticky bottom-0 h-6 bg-gradient-to-t from-background to-transparent",
											),
										],
										[],
									),
								],
			),
			pressable(
				h,
				{
					onClick: Message.ClickedCreate({ templateId: BLANK_TEMPLATE_ID }),
					className:
						"flex shrink-0 items-center gap-2.5 border-t border-border bg-sidebar py-3 pr-4 pl-4 text-left hover:bg-surface-sunken active:bg-surface-sunken",
				},
				[
					h.span(
						[
							h.Class(
								"flex size-5.5 shrink-0 items-center justify-center rounded-sm border border-input border-dashed",
							),
						],
						[icon(h, "PlusIcon", { size: 12, className: "text-muted-foreground" })],
					),
					h.span(
						[h.Class("flex min-w-0 grow items-baseline gap-2.25")],
						[
							h.span([h.Class("text-sm text-foreground")], ["Blank dashboard"]),
							h.span([h.Class("text-muted-foreground text-2xs")], ["start from nothing"]),
						],
					),
					icon(h, "ArrowRightIcon", { size: 14, className: "text-muted-foreground shrink-0" }),
				],
			),
		],
	)
}
