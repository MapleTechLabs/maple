import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { logsStreamToolbar } from "@maple/views/ui/logs/logs-stream-toolbar"
import { Message } from "./message"
import type { Model } from "./model"

// The logs table toolbar. Pinned columns live in `?columns`.

export const toolbar = (h: HtmlBuilder<Message>, model: Model): Html =>
	logsStreamToolbar(h, {
		tooltip: model.toolbarTooltip,
		toTooltipMessage: (message) => Message.GotToolbarTooltipMessage({ message }),
		columnsPopover: model.columnsPopover,
		toColumnsPopoverMessage: (message) => Message.GotColumnsPopoverMessage({ message }),
		columnOptions: Option.getOrElse(AsyncData.getData(model.attributeKeys.data), () => []),
		pinnedColumns: model.search.columns ?? [],
		onToggleColumn: (key) => Message.ToggledColumn({ key }),
		sections: model.filterSections,
		toSectionsMessage: (message) => Message.GotFilterSectionsMessage({ message }),
		wrap: model.wrap,
		onToggleWrap: Message.ClickedWrap(),
		density: model.density,
		onToggleDensity: Message.ClickedDensity(),
		className: "pb-1.5",
	})
