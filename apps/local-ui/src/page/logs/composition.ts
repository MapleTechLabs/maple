import * as FilterSections from "@maple/web/ui/filters/filter-sections"
import { ToggleGroupBlock } from "@maple/web/ui/toggle-group"
import { TooltipBlock } from "@maple/web/ui/tooltip"
import { Tuple } from "effect"
import type { Block } from "foldkit"
import { LogSheetBlock } from "../kit/log-sheet/block"
import { RelayModeChoice } from "./command"
import { LogsDefinition, makeStep } from "./definition"
import { CHIP_JSON_TOOLTIP_ID } from "./model"
import { PlaceLocalChipCard } from "./mount"
import { ObserveLogsViewport } from "./virtualize"

/** The filter rail's remembered open/closed sections and their searches. */
export const FilterSectionsBinding = LogsDefinition.makeBinding(FilterSections.FilterSectionsBlock, {
	field: "sections",
})

/**
 * The List / Patterns toggle. The hash owns the mode, and a fold cannot read it, so a press is
 * relayed back as `ChoseMode` for the update to compare and navigate.
 */
export const ModeToggleBinding = LogsDefinition.makeBinding(ToggleGroupBlock, {
	field: "modeToggle",
	init: false,
}).withOutMessagePolicy({
	fold: LogsDefinition.makeOutMessageFold(ToggleGroupBlock, {
		ToggledItem: ({ value }) => makeStep((model) => ({ model, commands: [RelayModeChoice({ value })] })),
	}),
})

/** The detail sheet, once a row was opened; it stays (closed) so the row stays selected. */
export const LogSheetBinding = LogsDefinition.makeBinding(LogSheetBlock, { field: "maybeDetail", init: false })

/** The tooltip on the card JSON block copy button (`<CopyButton tooltip>`). */
export const ChipJsonTooltipBinding = LogsDefinition.makeBinding(TooltipBlock, {
	field: "chipJsonTooltip",
	init: { contextToArgs: () => Tuple.make(CHIP_JSON_TOOLTIP_ID) },
})

export const LogsComposition = LogsDefinition.makeComposition({
	bindings: [FilterSectionsBinding, ModeToggleBinding, LogSheetBinding, ChipJsonTooltipBinding],
	mounts: [ObserveLogsViewport, PlaceLocalChipCard],
})
export type LogsViewBuilder = Block.ViewBuilderFor<typeof LogsComposition>
