import { cn } from "@maple/ui/lib/utils"
import { collapsiblePanelStyles } from "@maple/ui/styles/ui/collapsible"
import { eyebrowVariants } from "@maple/ui/styles/ui/eyebrow"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../button"
import { badge } from "../display"
import { filterChip } from "../filter-chip"
import { icon } from "../icon"
import { input } from "../input"
import { Message as SectionsMessage, type Model as SectionsModel, sectionOf } from "./filter-sections"
import { formatRange, type RangeUnit, UNIT_SUFFIX, UNIT_WORDS } from "./range-format"
import { type HistogramMessage, type RangeBucket, rangeHistogram } from "./range-histogram"

// Port of `RangeFilterSection` (packages/ui/src/components/filters/range-filter-section.tsx).
// The draft text lives in the caller's Model; it commits on blur, Enter or the caller's debounce.

export type RangePreset = Readonly<{ key: string; label: string; value?: string; min?: number; max?: number }>

export type RangeFilterSectionConfig<M> = Readonly<{
	title: string
	/** One short line under the header, for meaning the label can't carry. */
	hint?: string
	unit: RangeUnit
	/** The distribution above the inputs (drawn when it has more than one bucket). */
	histogram?: ReadonlyArray<RangeBucket>
	histogramUnitLabel?: string
	/** The bar under the pointer (the readout names it), and the histogram's pointer Messages. */
	histogramHover?: number | undefined
	/** The bar a held press went down on, for the drag preview. */
	histogramDrag?: number | undefined
	onHistogram?: (message: HistogramMessage) => M
	minValue: number | undefined
	maxValue: number | undefined
	draft: Readonly<{ min: string; max: string }>
	presets: ReadonlyArray<RangePreset>
	/** Base UI `useId`s for the panel and the two inputs. */
	ids: Readonly<{ panel: string; min: string; max: string }>
	sections: SectionsModel
	toSectionsMessage: (message: SectionsMessage) => M
	onDraftChange: (min: string, max: string) => M
	onCommitDraft: M
	/** A preset, the clear button or the badge's ×: applied at once. */
	onApply: (min: number | undefined, max: number | undefined) => M
}>

const boundInput = <M>(h: HtmlBuilder<M>, config: RangeFilterSectionConfig<M>, side: "min" | "max"): Html =>
	input(h, {
		id: config.ids[side],
		size: "sm",
		className: "text-xs",
		attributes: [
			h.AriaLabel(
				`${side === "min" ? "Minimum" : "Maximum"} ${config.title.toLowerCase()} (${UNIT_WORDS[config.unit]})`,
			),
			h.InputMode("decimal"),
			h.Placeholder(side === "min" ? "0" : "max"),
			h.Value(config.draft[side]),
			h.OnInput((value) =>
				side === "min"
					? config.onDraftChange(value, config.draft.max)
					: config.onDraftChange(config.draft.min, value),
			),
			h.OnBlur(config.onCommitDraft),
			h.OnKeyDownPreventDefault((key) =>
				key === "Enter" ? Option.some(config.onCommitDraft) : Option.none(),
			),
		],
	})

/** `applyPreset`: the active preset clicked again clears the range. */
const presetMessage = <M>(config: RangeFilterSectionConfig<M>, preset: RangePreset): M =>
	config.minValue === preset.min && config.maxValue === preset.max
		? config.onApply(undefined, undefined)
		: config.onApply(preset.min, preset.max)

const panelBody = <M>(h: HtmlBuilder<M>, config: RangeFilterSectionConfig<M>): Html => {
	const hasActiveRange = config.minValue !== undefined || config.maxValue !== undefined
	const hasUnitText = /[a-z$]/i.test(config.draft.min) || /[a-z$]/i.test(config.draft.max)
	const { onHistogram } = config
	const histogram =
		config.histogram !== undefined && config.histogram.length > 1 && onHistogram !== undefined
			? rangeHistogram(h, {
					buckets: config.histogram,
					unit: config.unit,
					unitLabel: config.histogramUnitLabel ?? "sessions",
					title: config.title,
					minValue: config.minValue,
					maxValue: config.maxValue,
					hoveredIndex: config.histogramHover,
					dragStart: config.histogramDrag,
					toMessage: onHistogram,
				})
			: null
	return h.div(
		[h.Class("space-y-2")],
		[
			...(config.hint === undefined || config.hint === ""
				? []
				: [h.p([h.Class("text-xs text-foreground-subtle")], [config.hint])]),
			...(histogram === null ? [] : [histogram]),
			h.div(
				[h.Class("flex items-center gap-1.5")],
				[
					boundInput(h, config, "min"),
					h.span([h.Class("text-xs text-muted-foreground")], ["–"]),
					boundInput(h, config, "max"),
					h.span(
						[h.Class("w-5 shrink-0 text-xs text-muted-foreground")],
						hasUnitText ? [] : [UNIT_SUFFIX[config.unit]],
					),
				],
			),
			...(config.presets.length > 0 || hasActiveRange
				? [
						h.div(
							[h.Class("flex flex-wrap items-center gap-1")],
							[
								...config.presets.map((preset) =>
									filterChip(
										h,
										{
											size: "xs",
											isPressed:
												config.minValue === preset.min &&
												config.maxValue === preset.max,
											onClick: presetMessage(config, preset),
											count: preset.value === "" ? undefined : preset.value,
										},
										[preset.label],
									),
								),
								...(hasActiveRange
									? [
											button(
												h,
												{
													variant: "link",
													size: "xs",
													className:
														"ml-auto text-muted-foreground hover:text-foreground active:text-foreground",
													attributes: [
														h.OnClick(config.onApply(undefined, undefined)),
													],
												},
												["Clear"],
											),
										]
									: []),
							],
						),
					]
				: []),
		],
	)
}

/** A collapsible min/max range with shortcut presets. */
export const rangeFilterSection = <M>(h: HtmlBuilder<M>, config: RangeFilterSectionConfig<M>): Html => {
	const { isOpen } = sectionOf(config.sections, config.title, true)
	return h.div(
		[h.DataAttribute(isOpen ? "open" : "closed", ""), h.DataAttribute("slot", "collapsible")],
		[
			trigger(h, config, isOpen),
			...(isOpen
				? [
						h.div(
							[
								h.Class(collapsiblePanelStyles),
								h.DataAttribute("open", ""),
								h.DataAttribute("slot", "collapsible-panel"),
								h.Id(config.ids.panel),
								h.Style({
									"--collapsible-panel-height": "auto",
									"--collapsible-panel-width": "auto",
									"animation-name": "none",
								}),
							],
							[h.div([h.Class("pb-3")], [panelBody(h, config)])],
						),
					]
				: []),
		],
	)
}

const trigger = <M>(h: HtmlBuilder<M>, config: RangeFilterSectionConfig<M>, isOpen: boolean): Html => {
	const hasActiveRange = config.minValue !== undefined || config.maxValue !== undefined
	return h.button(
		[
			...(isOpen ? [h.AriaControls(config.ids.panel)] : []),
			h.AriaDisabled(false),
			h.AriaExpanded(isOpen),
			h.Class(
				cn(
					"group flex w-full items-center justify-between gap-2 py-2 hover:text-foreground active:text-foreground text-muted-foreground",
					eyebrowVariants({ variant: "label" }),
				),
			),
			...(isOpen ? [h.DataAttribute("panel-open", "")] : []),
			h.DataAttribute("slot", "collapsible-trigger"),
			h.Tabindex(0),
			h.Type("button"),
			h.OnClick(
				config.toSectionsMessage(
					SectionsMessage.ToggledSection({ key: config.title, defaultOpen: true }),
				),
			),
		],
		[
			h.span([h.Class("truncate")], [config.title]),
			h.span(
				[h.Class("flex items-center gap-1.5")],
				[
					...(!isOpen && hasActiveRange
						? [
								badge(
									h,
									{
										variant: "muted",
										size: "xs",
										mono: true,
										className: "tracking-normal",
									},
									[
										formatRange(config.minValue, config.maxValue, config.unit),
										h.span(
											[
												h.Role("button"),
												h.Tabindex(0),
												h.AriaLabel(`Clear ${config.title.toLowerCase()} filter`),
												h.Class("rounded-xs hover:text-muted-foreground active:text-muted-foreground"),
												h.OnClick(config.onApply(undefined, undefined), {
													propagation: "Stop",
												}),
											],
											[icon(h, "XmarkIcon", { className: "size-3" })],
										),
									],
								),
							]
						: []),
					icon(h, "ChevronDownIcon", {
						className: cn(
							"size-3.5 shrink-0 text-foreground-faint transition-[transform,color] duration-200 ease-out group-hover:text-muted-foreground",
							isOpen && "rotate-180",
						),
					}),
				],
			),
		],
	)
}
