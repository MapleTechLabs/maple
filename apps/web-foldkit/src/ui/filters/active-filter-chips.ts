import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../button"
import { icon } from "../icon"
import { iconButton } from "../icon-button"

// Port of `ActiveFilterChips` (packages/ui/src/components/filters/active-filter-chips.tsx).

const MAX_CHIP_VALUES = 3

export type ActiveFilterChip<M> = Readonly<{
	id: string
	label: string
	values: ReadonlyArray<string>
	isNegated?: boolean
	onRemove: M
	/** Stored value to display text (`getValueLabel`): a trace id shows its short form. */
	valueLabel?: (value: string) => string
}>

const summarize = <M>(chip: ActiveFilterChip<M>): string => {
	const labelFor = (value: string) => chip.valueLabel?.(value) ?? value
	const shown = chip.values.slice(0, MAX_CHIP_VALUES).map(labelFor).join(", ")
	const rest = chip.values.length - MAX_CHIP_VALUES
	return rest > 0 ? `${shown} +${rest}` : shown
}

/** The row of applied filters above a result list; nothing when no filter is set. */
export const activeFilterChips = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ chips: ReadonlyArray<ActiveFilterChip<M>>; onClearAll?: M; className?: string }>,
): Html | null => {
	if (options.chips.length === 0) return null
	return h.div(
		[h.Class(cn("mb-4 flex flex-wrap items-center gap-1.5", options.className))],
		[
			...options.chips.map((chip) => {
				const isNegated = chip.isNegated ?? false
				const description = `${chip.label} ${isNegated ? "is not" : "is"} ${chip.values.join(", ")}`
				return h.span(
					[
						h.Key(chip.id),
						h.Title(description),
						h.Class(
							cn(
								"inline-flex max-w-full items-center gap-1.5 rounded-md border py-1 pr-1 pl-2 text-xs",
								isNegated
									? "border-dashed border-destructive/40 bg-destructive/5 text-destructive"
									: "border-border/60 bg-muted/40 text-foreground",
							),
						),
					],
					[
						h.span(
							[h.Class("truncate")],
							[
								h.span([h.Class("text-muted-foreground")], [chip.label]),
								" ",
								h.span(
									[h.Class(cn(isNegated ? "font-medium" : "text-muted-foreground"))],
									[isNegated ? "is not" : "is"],
								),
								" ",
								h.span([h.Class("font-medium")], [summarize(chip)]),
							],
						),
						iconButton(
							h,
							{
								size: "icon-xs",
								label: `Remove filter: ${description}`,
								className: "-my-1 text-current/60 hover:bg-current/10 hover:text-current",
								attributes: [h.OnClick(chip.onRemove)],
							},
							[icon(h, "XmarkIcon")],
						),
					],
				)
			}),
			...(options.onClearAll !== undefined && options.chips.length > 1
				? [
						button(
							h,
							{
								variant: "link",
								size: "xs",
								className: "ml-1 text-muted-foreground hover:text-foreground",
								attributes: [h.OnClick(options.onClearAll)],
							},
							["Clear all"],
						),
					]
				: []),
		],
	)
}
