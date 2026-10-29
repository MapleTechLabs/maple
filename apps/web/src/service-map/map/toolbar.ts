import { Schema } from "effect"
import * as Combobox from "../../ui/combobox"
import { ComboboxBlock } from "../../ui/combobox-view"
import * as Select from "../../ui/select"
import { SelectBlock } from "../../ui/select-view"
import * as Tooltip from "../../ui/tooltip"

// The toolbar's child Models (`ServiceMapToolbar`); its view is `toolbar-view.ts`.

/** `TRAFFIC_FILTER_STEPS`: discrete thresholds (% of the peak edge rate); 0 shows everything. */
export const TRAFFIC_FILTER_STEPS = [0, 0.1, 1, 5] as const

export const FOCUS_COMBOBOX_ID = "service-map-focus"

export const Model = Schema.Struct({
	focusCombobox: Combobox.Model,
	trafficSelect: Select.Model,
	colorSelect: Select.Model,
	depthSelect: Select.Model,
	tooltip: Tooltip.Model,
})
export type Model = typeof Model.Type

/** The toolbar's child Models; the map binds each one through its own Binding. */
export const init = (): Model => ({
	focusCombobox: ComboboxBlock.init(FOCUS_COMBOBOX_ID, "single").model,
	trafficSelect: SelectBlock.init("service-map-traffic", { value: "0", selectedIndex: 0 }).model,
	colorSelect: SelectBlock.init("service-map-color", { value: "service", selectedIndex: 0 }).model,
	depthSelect: SelectBlock.init("service-map-depth", { value: "1", selectedIndex: 0 }).model,
	tooltip: Tooltip.TooltipBlock.init("service-map-toolbar-tip", { side: "bottom" }).model,
})
