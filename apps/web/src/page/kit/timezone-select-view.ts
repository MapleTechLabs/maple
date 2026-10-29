import { cn } from "@maple/ui/lib/utils"
import * as C from "@maple/ui/styles/ui/combobox"
import type { Html } from "foldkit/html"
import * as Combobox from "../../ui/combobox"
import { inputAttributes, listPopup } from "../../ui/combobox-view"
import { icon } from "../../ui/icon"
import { SYSTEM_VALUE } from "../../platform/time-zone"
import { matchesZoneQuery, type ZoneRow } from "./timezone-zones"

// The timezone select's list: the search input, "No timezone matches that." and the grouped
// zone list with clock and offset.

export type ZoneListInputs = Readonly<{
	rows: ReadonlyArray<ZoneRow>
	triggerId: string
	/** The footer row: the list spans its width (`anchor={anchor}`, `w-(--anchor-width)`). */
	anchorId: string
	/** The picker popover's id: a press in the list stays inside it. */
	popoverId: string
}>

type H = Combobox.ComboboxViewBuilder

const itemText = (h: H, row: ZoneRow): ReadonlyArray<Html | string> => [
	h.span(
		[h.Class("flex items-center gap-3")],
		[
			h.span(
				[h.Class("min-w-0 flex-1 truncate")],
				row.value === SYSTEM_VALUE
					? [
							h.span([], ["System"]),
							h.span([h.Class("text-muted-foreground/70")], [` · ${row.zone}`]),
						]
					: row.isPinned
						? [h.span([], [row.zone])]
						: [
								h.span([], [row.city]),
								h.span([h.Class("text-muted-foreground/50")], [` · ${row.region}`]),
							],
			),
			h.span([h.Class("shrink-0 font-mono text-2xs tabular-nums text-foreground/70")], [row.clock]),
			h.span(
				[
					h.Class(
						"w-14 shrink-0 text-right font-mono text-3xs tabular-nums text-muted-foreground/70",
					),
				],
				[row.offset],
			),
		],
	),
]

export const zoneListView = Combobox.ComboboxComposition.makeView.withInputs<ZoneListInputs>(
	(model, inputs, h) => {
		const matches = inputs.rows.filter((row) => matchesZoneQuery(row, Combobox.queryOf(model)))
		const byValue = new Map(matches.map((row) => [row.value, row]))
		const items = matches.map((row) => row.value)
		return listPopup(h, model, {
			slot: "combobox",
			items,
			isPrefiltered: true,
			emptyText: "No timezone matches that.",
			anchorSelector: `#${inputs.triggerId}`,
			positionSelector: `#${inputs.anchorId}`,
			className: "w-(--anchor-width)",
			positionerClassName: "z-60",
			nestedIn: inputs.popoverId,
			listClassName: "max-h-80 overflow-y-auto p-1.5",
			// The zones group follows the pinned one: `[[role=group]+&]` draws its top rule.
			itemClassName: (value) =>
				cn(
					"min-h-7 text-xs",
					byValue.get(value)?.startsGroup === true && "mt-1 border-t border-border/60 pt-1",
				),
			renderItem: (value) => rowText(byValue, value, h),
			trigger: {
				returnFocusId: inputs.triggerId,
				header: h.div(
					[h.Class("flex items-center gap-2 border-b border-border/70 px-3")],
					[
						icon(h, "GlobeIcon", { className: "size-3.5 shrink-0 text-muted-foreground/60" }),
						h.input([
							h.Class(
								cn(
									C.comboboxChipsInputStyles,
									C.comboboxChipsInputSmStyles,
									"h-9 w-full ps-0 text-xs",
								),
							),
							h.DataAttribute("size", "sm"),
							h.Attribute("autofocus", ""),
							...inputAttributes(
								h,
								{ ...model, inputValue: Combobox.queryOf(model) },
								{
									slot: "combobox-chips-input",
									placeholder: "City, offset, or the time there now…",
									items,
									isUnfiltered: true,
								},
								(message) => message,
							),
						]),
					],
				),
			},
		})
	},
)

const rowText = (
	byValue: ReadonlyMap<string, ZoneRow>,
	value: string,
	h: H,
): ReadonlyArray<Html | string> => {
	const row = byValue.get(value)
	return row === undefined ? [value] : itemText(h, row)
}
