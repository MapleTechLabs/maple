import { formatNumber } from "@maple/domain/format"
import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { collapsiblePanelStyles } from "@maple/ui/styles/ui/collapsible"
import { eyebrowVariants } from "@maple/ui/styles/ui/eyebrow"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../button"
import * as Checkbox from "../checkbox"
import { badge } from "../display"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import { emptyMessage } from "../empty"
import { icon, iconColor, type IconName } from "../icon"
import { label } from "../label"
import type { SectionRender, ViewInputs as SectionViewInputs } from "./filter-sections"

// Port of `FilterSection` / `SearchableFilterSection` (packages/ui/src/components/filters/filter-section.tsx).
// Alt+click on a label toggles the exclusion: `OnClick` carries no modifiers, so the root's
// `altClickExclude` Subscription reads it and presses the row's Exclude action (`data-alt-exclude`).

export type FilterOption = Readonly<{ name: string; count: number }>

/** Matches rendered while searching; past this the answer is a longer search term. */
const MAX_SEARCH_RESULTS = 50

// copied: `visibleFilterOptions` (the React module also holds the components).
const visibleFilterOptions = (input: {
	readonly options: ReadonlyArray<FilterOption>
	readonly selected: ReadonlyArray<string>
	readonly excluded: ReadonlyArray<string>
	readonly search: string
	readonly isShowingAll: boolean
	readonly maxVisible: number
}) => {
	const chosen = new Set([...input.selected, ...input.excluded])
	const present = new Set(input.options.map((option) => option.name))
	const missing = [...chosen].filter((name) => !present.has(name)).map((name) => ({ name, count: 0 }))
	const ordered =
		chosen.size === 0
			? input.options
			: [...input.options, ...missing].toSorted(
					(a, b) => Number(chosen.has(b.name)) - Number(chosen.has(a.name)),
				)
	if (input.search === "") {
		return {
			visible: input.isShowingAll ? ordered : ordered.slice(0, input.maxVisible),
			hasMore: Math.max(0, ordered.length - input.maxVisible),
			overflowingMatches: 0,
		}
	}
	const needle = input.search.toLowerCase()
	const matches = ordered.filter((option) => option.name.toLowerCase().includes(needle))
	return {
		visible: matches.slice(0, MAX_SEARCH_RESULTS),
		hasMore: 0,
		overflowingMatches: Math.max(0, matches.length - MAX_SEARCH_RESULTS),
	}
}

export type FilterSectionConfig<M> = Readonly<{
	title: string
	options: ReadonlyArray<FilterOption>
	selected: ReadonlyArray<string>
	/** Values filtered out; with `onExclude` the section is tri-state and rows get Only / Exclude. */
	excluded?: ReadonlyArray<string>
	isSearchable?: boolean
	maxVisible?: number
	defaultOpen?: boolean
	/** Embeds the page's `FilterSectionsBlock` binding: `h.block(Binding.embedView({ slotId, model, viewInputs }))`. */
	embedSection: (viewInputs: SectionViewInputs) => Html
	/** The checkbox was toggled: include it, or drop it from both lists. */
	onToggle: (name: string) => M
	onOnly?: (name: string) => M
	onExclude?: (name: string) => M
	/** `colorMap`: a swatch before the label (`serviceColorMap` for services). */
	colorOf?: (name: string) => string | undefined
	/** `getOptionIcon`: a mark before the label (browser, device, vendor), tinted by `getOptionIconColor`. */
	getOptionIcon?: (name: string) => IconName | undefined
	getOptionIconColor?: (name: string) => string | undefined
	/** `renderOptionIcon`: an already-built node in the same slot (a tag dot, a favicon). */
	renderOptionIcon?: (name: string) => Html | undefined
	getOptionLabel?: (name: string) => string
	/** The label's `title` when it is more than the label. */
	getOptionDescription?: (name: string) => string | undefined
	showCounts?: boolean
	/** The info mark beside the title (`FilterDescription`'s closed trigger). */
	hasDescription?: boolean
}>

/** `FilterRowAction`: the `tag` badge as a button, transparent until the row is hovered. */
const rowAction = <M>(
	h: HtmlBuilder<M>,
	text: string,
	labelText: string,
	onClick: M,
	isPressed: boolean | undefined,
): Html =>
	h.button(
		[
			h.AriaLabel(labelText),
			...(isPressed === undefined ? [] : [h.AriaPressed(String(isPressed))]),
			h.Class(
				cn(
					badgeVariants({
						variant: "tag",
						className: cn(
							"transition-colors",
							isPressed === true
								? "bg-destructive/12 text-destructive [button&]:hover:bg-destructive/20 [button&]:hover:text-destructive"
								: "bg-transparent",
						),
					}),
				),
			),
			h.DataAttribute("slot", "badge"),
			h.Title(labelText),
			...(text === "Exclude" ? [h.DataAttribute("filter-exclude", "")] : []),
			h.Type("button"),
			h.OnClick(onClick),
		],
		[text],
	)

const countText = <M>(h: HtmlBuilder<M>, option: FilterOption, isTriState: boolean): Html =>
	h.span(
		[
			h.Class(
				cn(
					"text-xs text-muted-foreground tabular-nums transition-opacity",
					isTriState &&
						"group-hover/option:opacity-0 group-focus-within/option:opacity-0 pointer-coarse:opacity-0",
				),
			),
			h.Title(option.count.toLocaleString("en-US")),
		],
		[formatNumber(option.count)],
	)

/** `FilterDescription`'s closed trigger: the info mark (TODO(tooltip): the popup is not ported). */
export const filterDescriptionMark = <M>(h: HtmlBuilder<M>, title: string): Html =>
	h.span(
		[
			h.AriaLabel(`About ${title}`),
			h.Class("inline-flex shrink-0 text-muted-foreground/50 hover:text-muted-foreground"),
			h.DataAttribute("base-ui-tooltip-trigger", ""),
			h.DataAttribute("slot", "tooltip-trigger"),
			h.Tabindex(0),
		],
		[icon(h, "CircleInfoIcon", { className: "size-3" })],
	)
const swatch = <M>(h: HtmlBuilder<M>, color: string | undefined, isExcluded: boolean): Html[] =>
	color === undefined || color === ""
		? []
		: [
				h.span(
					[
						h.Class(
							cn(
								"size-2.5 rounded-[35%] [corner-shape:squircle] shrink-0",
								isExcluded && "opacity-40",
							),
						),
						h.Style({ "background-color": color }),
					],
					[],
				),
			]

/** `getOptionIcon` / `getOptionIconColor`: a brand mark before the label. */
const optionIcon = <M>(
	h: HtmlBuilder<M>,
	config: FilterSectionConfig<M>,
	name: string,
	isExcluded: boolean,
): ReadonlyArray<Html> => {
	const iconName = config.getOptionIcon?.(name)
	if (iconName !== undefined)
		return [
			icon(h, iconName, {
				className: cn("size-3.5 shrink-0", isExcluded && "opacity-40"),
				...iconColor(config.getOptionIconColor?.(name)),
			}),
		]
	const node = config.renderOptionIcon?.(name)
	return node === undefined ? [] : [node]
}

const optionRow = <M>(h: HtmlBuilder<M>, config: FilterSectionConfig<M>, option: FilterOption): Html => {
	const excluded = config.excluded ?? []
	const isExcluded = excluded.includes(option.name)
	const inputId = `${config.title}-${option.name}`
	const text = config.getOptionLabel?.(option.name) ?? option.name
	const optionLabel = isExcluded ? `${text} (excluded)` : text
	const title = isExcluded ? optionLabel : (config.getOptionDescription?.(option.name) ?? text)
	const isTriState = config.onExclude !== undefined
	// Keyed by name: a reorder (selected first) moves the focused row with it.
	return h.div(
		[
			h.Key(option.name),
			h.Class("group/option flex items-center gap-2"),
			...(isExcluded ? [h.DataAttribute("excluded", "")] : []),
		],
		[
			...Checkbox.view(h, {
				model: { isChecked: config.selected.includes(option.name) || isExcluded },
				toParentMessage: () => config.onToggle(option.name),
				id: `${inputId}-checkbox`,
				inputId,
				isIndeterminate: isExcluded,
				ariaLabel: optionLabel,
				className: cn(
					isExcluded &&
						"border-destructive/40 [&_[data-slot=checkbox-indicator]]:bg-destructive/12 [&_[data-slot=checkbox-indicator]]:text-destructive",
				),
			}),
			label(
				h,
				{
					className: cn(
						"flex-1 min-w-0 flex items-center gap-1.5 cursor-pointer text-xs font-normal",
						isExcluded
							? "text-muted-foreground/70 line-through decoration-1 decoration-muted-foreground/50"
							: "text-foreground",
					),
					attributes: [
						h.For(inputId),
						h.Id(Checkbox.labelId(inputId)),
						h.Title(title),
						...(isTriState ? [h.DataAttribute("alt-exclude", "")] : []),
					],
				},
				[
					...swatch(h, config.colorOf?.(option.name), isExcluded),
					...optionIcon(h, config, option.name, isExcluded),
					h.span([h.Class("truncate")], [text]),
				],
			),
			h.span(
				[h.Class("relative flex shrink-0 items-center justify-end")],
				[
					...(config.showCounts === false ? [] : [countText(h, option, isTriState)]),
					...(config.onExclude === undefined
						? []
						: [
								h.span(
									[
										h.Class(
											"pointer-events-none absolute inset-y-0 right-0 flex items-center gap-1 bg-background opacity-0 transition-opacity before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-6 before:bg-gradient-to-r before:from-transparent before:to-background group-hover/option:pointer-events-auto group-hover/option:opacity-100 group-focus-within/option:pointer-events-auto group-focus-within/option:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
										),
									],
									[
										...(config.onOnly === undefined
											? []
											: [
													rowAction(
														h,
														"Only",
														`Show only ${text}`,
														config.onOnly(option.name),
														undefined,
													),
												]),
										rowAction(
											h,
											"Exclude",
											isExcluded ? `Stop excluding ${text}` : `Exclude ${text}`,
											config.onExclude(option.name),
											isExcluded,
										),
									],
								),
							]),
				],
			),
		],
	)
}

/** The collapsed trigger's badges: how many are included, and (in red) excluded. */
const collapsedBadges = <M>(h: HtmlBuilder<M>, selected: number, excluded: number): Html[] => [
	...(selected > 0
		? [
				badge(h, { variant: "muted", size: "xs", mono: true, className: "tracking-normal" }, [
					String(selected),
				]),
			]
		: []),
	...(excluded > 0
		? [
				badge(h, { variant: "crit", size: "xs", mono: true, className: "tracking-normal" }, [
					`−${excluded}`,
				]),
			]
		: []),
]

/** One facet section: a collapsible list of checkbox rows, optionally searchable. */
export const filterSection = <M>(h: HtmlBuilder<M>, config: FilterSectionConfig<M>): Html | null => {
	const excluded = config.excluded ?? []
	if (config.options.length === 0 && excluded.length === 0 && config.selected.length === 0) return null
	const defaultOpen = config.defaultOpen ?? true
	const isSearchable = config.isSearchable ?? false
	const toView = (render: SectionRender) => sectionBody(h, config, excluded, isSearchable, render)
	if (!isSearchable) return config.embedSection({ key: config.title, defaultOpen, toView })
	return config.embedSection({
		key: config.title,
		defaultOpen,
		search: {
			id: `filter-section-${config.title}-search`,
			placeholder: `Search ${config.title.toLowerCase()}...`,
		},
		toView,
	})
}

const sectionBody = <M>(
	h: HtmlBuilder<M>,
	config: FilterSectionConfig<M>,
	excluded: ReadonlyArray<string>,
	isSearchable: boolean,
	{ state, toggle, showMore, searchInput }: SectionRender,
): Html => {
	const { visible, hasMore, overflowingMatches } = visibleFilterOptions({
		options: config.options,
		selected: config.selected,
		excluded,
		search: isSearchable ? state.search : "",
		isShowingAll: state.isShowingAll,
		maxVisible: config.maxVisible ?? 5,
	})
	const panelId = `filter-section-${config.title}-panel`
	return h.div(
		[h.DataAttribute(state.isOpen ? "open" : "closed", ""), h.DataAttribute("slot", "collapsible")],
		[
			h.button(
				[
					...(state.isOpen ? [h.AriaControls(panelId)] : []),
					h.AriaDisabled(false),
					h.AriaExpanded(state.isOpen),
					h.Class(
						cn(
							"group flex w-full items-center justify-between gap-2 py-2 hover:text-foreground text-muted-foreground transition-colors",
							eyebrowVariants({ variant: "label" }),
						),
					),
					...(state.isOpen ? [h.DataAttribute("panel-open", "")] : []),
					h.DataAttribute("slot", "collapsible-trigger"),
					h.Tabindex(0),
					h.Type("button"),
					...toggle,
				],
				[
					h.span(
						[h.Class("flex min-w-0 items-center gap-1.5")],
						[
							h.span([h.Class("truncate")], [config.title]),
							...(config.hasDescription === true
								? [filterDescriptionMark(h, config.title)]
								: []),
						],
					),
					h.span(
						[h.Class("flex items-center gap-1.5")],
						[
							...(state.isOpen
								? []
								: collapsedBadges(h, config.selected.length, excluded.length)),
							icon(h, "ChevronDownIcon", {
								className: cn(
									"size-3.5 shrink-0 text-muted-foreground/40 transition-[transform,color] duration-200 ease-out group-hover:text-muted-foreground",
									state.isOpen && "rotate-180",
								),
							}),
						],
					),
				],
			),
			...(state.isOpen
				? [
						h.div(
							[
								h.Class(collapsiblePanelStyles),
								h.DataAttribute("open", ""),
								h.DataAttribute("slot", "collapsible-panel"),
								h.Id(panelId),
								h.Style({
									"--collapsible-panel-height": "auto",
									"--collapsible-panel-width": "auto",
									"animation-name": "none",
								}),
							],
							[
								h.div(
									[h.Class("pb-3")],
									[
										...(isSearchable ? [searchInput] : []),
										h.div(
											[h.Class("space-y-2")],
											[
												...(visible.length === 0
													? [
															emptyMessage(h, { className: "py-2" }, [
																"No matches found",
															]),
														]
													: visible.map((option) => optionRow(h, config, option))),
												...(overflowingMatches > 0
													? [
															h.p(
																[
																	h.Class(
																		"text-xs text-muted-foreground py-1",
																	),
																],
																[
																	`${countLabel(overflowingMatches, "more match", "more matches")}, keep typing to narrow`,
																],
															),
														]
													: []),
												...(hasMore > 0
													? [
															button(
																h,
																{
																	variant: "link",
																	size: "xs",
																	className:
																		"px-0 text-muted-foreground hover:text-foreground",
																	attributes: showMore,
																},
																[
																	state.isShowingAll
																		? "Show less"
																		: `Show ${hasMore} more`,
																],
															),
														]
													: []),
											],
										),
									],
								),
							],
						),
					]
				: []),
		],
	)
}

/** `SingleCheckboxFilter`: one checkbox with its label (and count). */
export const singleCheckboxFilter = <M>(
	h: HtmlBuilder<M>,
	config: Readonly<{ title: string; isChecked: boolean; onToggle: M; count?: number }>,
): Html => {
	const inputId = `filter-${config.title}`
	return h.div(
		[h.Class("flex items-center gap-2 py-1.5")],
		[
			...Checkbox.view(h, {
				model: { isChecked: config.isChecked },
				toParentMessage: () => config.onToggle,
				id: `${inputId}-checkbox`,
				inputId,
			}),
			label(
				h,
				{
					className:
						"flex-1 min-w-0 flex items-center gap-1.5 cursor-pointer text-xs text-foreground font-normal",
					attributes: [h.For(inputId), h.Id(Checkbox.labelId(inputId)), h.Title(config.title)],
				},
				[h.span([h.Class("truncate")], [config.title])],
			),
			...(config.count === undefined
				? []
				: [
						h.span(
							[h.Class("text-xs text-muted-foreground tabular-nums")],
							[formatNumber(config.count)],
						),
					]),
		],
	)
}
