import { pieSampleData } from "@maple/ui/components/charts/_shared/sample-data"
import { Option } from "effect"
import {
	attr,
	click,
	expect,
	find,
	given,
	hover,
	Mount,
	role,
	scene,
	selector,
	tap,
	withViewInputs,
} from "foldkit/scene"
import { modifyFields } from "foldkit/struct"
import { describe, expect as expectValue, test } from "vitest"
import * as Chart from "./chart"
import { MeasureChartContainer, MountChart, PortalTooltipBody } from "./chart-mounts"
import { CHART_SPEC_ATTRIBUTE, ChartTooltip, decodeChartSpec } from "./chart-spec"
import * as PieChart from "./pie-chart"

// The production pie as the lab renders it: side stats legend once the card is measured wide.
const CARD_WIDTH = 670
const view = withViewInputs(PieChart.view, {
	chartId: "pie",
	data: pieSampleData,
	theme: { "--background": "#ffffff" },
	legend: "right",
	tooltip: "visible",
})()
const measured = modifyFields(Chart.init(), { containerWidth: () => CARD_WIDTH })

const legendRow = (name: string) => role("button", { name: new RegExp(`^${name}`) })
const tooltip = selector("[data-chart-tooltip-holder]")

/** What the chart Mount draws from: the pie spec on the plot box. */
const expectPieSpec = (expected: { activeName: string | null; highlighted: string | null }) =>
	tap<Chart.Model, Chart.Message>((simulation) => {
		const spec = Option.flatMap(
			Option.flatMap(find(simulation.html, "[data-chart-plot-box]"), attr(CHART_SPEC_ATTRIBUTE)),
			decodeChartSpec,
		)
		expectValue(
			Option.map(spec, (value) =>
				value._tag === "Pie"
					? { activeName: value.activeName, highlighted: value.highlighted }
					: value._tag,
			),
		).toEqual(Option.some(expected))
	})

const resolveMounts = (mountChartResult: Chart.Message) =>
	Mount.resolveAll(
		[MeasureChartContainer, Chart.Message.ResizedChartContainer({ width: CARD_WIDTH, height: 0 })],
		[MountChart, mountChartResult],
	)

const apiGatewaySlice = ChartTooltip.PieSlice({
	name: "api-gateway",
	value: 4820,
	fraction: 0.43,
	color: "#0a7",
})

describe("chart hover", () => {
	test("plot focus on a slice grows that slice", () => {
		scene(
			{ update: Chart.update, view },
			given(measured),
			expectPieSpec({ activeName: null, highlighted: null }),
			resolveMounts(Chart.Message.ChangedChartFocus({ maybeKey: Option.some("api-gateway") })),
			expectPieSpec({ activeName: "api-gateway", highlighted: null }),
		)
	})

	test("hovering a legend row grows its slice, clicking pins it until clicked again", () => {
		scene(
			{ update: Chart.update, view },
			given(measured),
			resolveMounts(Chart.Message.CompletedMountChart()),
			hover(legendRow("order-service")),
			expectPieSpec({ activeName: "order-service", highlighted: null }),
			click(legendRow("order-service")),
			expect(legendRow("order-service")).toHaveAttr("aria-pressed", "true"),
			expectPieSpec({ activeName: "order-service", highlighted: "order-service" }),
			click(legendRow("order-service")),
			expect(legendRow("order-service")).toHaveAttr("aria-pressed", "false"),
			expectPieSpec({ activeName: "order-service", highlighted: null }),
		)
	})

	test("the tooltip body follows the tooltip datum and goes when the tooltip hides", () => {
		scene(
			{ update: Chart.update, view },
			given(modifyFields(measured, { tooltip: () => Option.some(apiGatewaySlice) })),
			expect(tooltip).toContainText("api-gateway"),
			expect(tooltip).toContainText("4.8K"),
			expect(tooltip).toContainText("43%"),
			Mount.resolve(PortalTooltipBody, Chart.Message.CompletedPortalTooltipBody()),
			resolveMounts(Chart.Message.ChangedChartTooltip({ maybeTooltip: Option.none() })),
			Mount.expectEnded(PortalTooltipBody),
			expect(tooltip).toBeEmpty(),
		)
	})
})
