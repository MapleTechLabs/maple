import { Option, Schema } from "effect"
import type { Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { ChartTooltip } from "./chart-spec"

/**
 * One chart's interaction state, the part React kept in `useState` beside the chart: the hovered
 * datum (from the plot's focus or a legend row), the legend's pinned emphasis, the tooltip datum
 * and the measured container width. The library owns the canvas; this owns what the view reads.
 */

// MODEL

export const Model = Schema.Struct({
	/** `activeName`: the focused datum's key, shared by plot focus and legend hover. */
	activeKey: Schema.Option(Schema.String),
	/** `usePlotLegendHighlight`: a legend click pins one key until clicked again. */
	highlightedKey: Schema.Option(Schema.String),
	/** What the tooltip shell's body shows; `None` while the library hides it. */
	tooltip: Schema.Option(ChartTooltip),
	/** `useContainerSize(containerRef).width`, rounded; 0 before the first measurement. */
	containerWidth: Schema.Number,
})
export type Model = typeof Model.Type

export const init = (): Model => ({
	activeKey: Option.none(),
	highlightedKey: Option.none(),
	tooltip: Option.none(),
	containerWidth: 0,
})

// MESSAGE

export const Message = defineMessageUnion({
	CompletedMountChart: {},
	FailedMountChart: { reason: Schema.String },
	ChangedChartFocus: { maybeKey: Schema.Option(Schema.String) },
	ChangedChartTooltip: { maybeTooltip: Schema.Option(ChartTooltip) },
	CompletedPortalTooltipBody: {},
	ResizedChartContainer: { width: Schema.Number },
	EnteredLegendItem: { key: Schema.String },
	LeftLegend: {},
	ClickedLegendItem: { key: Schema.String },
})
export type Message = typeof Message.Type

// UPDATE

const toggled = (current: Option.Option<string>, key: string): Option.Option<string> =>
	Option.isSome(current) && current.value === key ? Option.none() : Option.some(key)

export const update = (model: Model, message: Message) =>
	Message.match<Update.Return<Model, Message>>(message, {
		CompletedMountChart: () => ({ model }),
		FailedMountChart: () => ({ model }),
		ChangedChartFocus: ({ maybeKey }) => ({ model: modifyFields(model, { activeKey: () => maybeKey }) }),
		ChangedChartTooltip: ({ maybeTooltip }) => ({
			model: modifyFields(model, { tooltip: () => maybeTooltip }),
		}),
		CompletedPortalTooltipBody: () => ({ model }),
		ResizedChartContainer: ({ width }) => ({
			model: modifyFields(model, { containerWidth: () => width }),
		}),
		EnteredLegendItem: ({ key }) => ({
			model: modifyFields(model, { activeKey: () => Option.some(key) }),
		}),
		LeftLegend: () => ({ model: modifyFields(model, { activeKey: () => Option.none() }) }),
		ClickedLegendItem: ({ key }) => ({
			model: modifyFields(model, { highlightedKey: (current) => toggled(current, key) }),
		}),
	})
