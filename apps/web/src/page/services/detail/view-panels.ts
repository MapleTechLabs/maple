import { formatThroughput } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "@maple/views/charts/chart"
import * as Sparkline from "@maple/views/charts/sparkline"
import { resolveColor, type ThemeColors } from "@maple/views/charts/theme-colors"
import { backdropBar } from "@maple/views/ui/meter"
import { pressable } from "@maple/views/ui/pressable"
import { textLink } from "@maple/views/ui/text-link"
import { panel, panelBody, panelHeader } from "@maple/views/ui/panel"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { errorRateValue, latencyValue } from "@maple/views/ui/values"
import { callsPerSecond, windowSeconds } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { Array as Arr } from "effect"
import { hstack } from "@maple/views/ui/stack"
import { dividedList } from "@maple/views/ui/rule"
import { typography } from "@maple/views/ui/typography"

// The Overview tab's quiet panels.

type H = HtmlBuilder<Message>

/** Calls and requests draw in the Throughput chart's colour on every tab. */
export const SPARKLINE_TOKEN = "--chart-throughput"

/** `SectionCard`: a `Panel` with a header title, an optional trailing action, and a body. */
export const sectionCard = (
	h: H,
	options: Readonly<{ title: string; action?: Html; className?: string }>,
	children: ReadonlyArray<Html>,
): Html =>
	panel(h, { className: options.className }, [
		panelHeader(h, { title: options.title, action: options.action }),
		panelBody(h, children),
	])

/** `ViewAllButton`: jumps from an Overview card to the full tab. */
export const viewAllButton = (h: H, onClick: Message): Html =>
	textLink(h, { className: "text-xs", onClick }, ["View all →"])

const PANEL_LIMIT = 5
const SPARKLINE_MODEL = Chart.init()
const toSparkline = (message: Chart.Message) => Message.GotChartMessage({ chartId: "sparkline", message })

/** `ServiceTopOperationsPanel`: nothing while loading or empty, five rows otherwise. */
export const topOperationsPanel = (h: H, model: Model, theme: ThemeColors | null): Html => {
	const operations = AsyncData.getOrElse(model.operations.data, () => []).slice(0, PANEL_LIMIT)
	if (operations.length === 0 || model.window === null) return null
	const seconds = windowSeconds(model.window)
	const maxCalls = Arr.reduce(operations, 0, (acc, op) => Math.max(acc, op.estimatedSpanCount))
	const color = resolveColor(theme ?? {}, SPARKLINE_TOKEN)
	const onViewAll = Message.ClickedTab({ tab: "operations" })
	return sectionCard(
		h,
		{
			title: "Top operations",
			className: refreshingClass(AsyncData.isRefreshing(model.operations.data)),
			action: viewAllButton(h, onViewAll),
		},
		[
			dividedList(
				h,
				{ as: "ul", bordered: false },
				Arr.map(operations, (op) =>
					h.li(
						[h.Key(op.spanName)],
						[
							pressable(
								h,
								{
									onClick: onViewAll,
									className:
										"relative flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface-sunken active:bg-surface-sunken focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
								},
								[
									backdropBar(h, {
										value: op.estimatedSpanCount,
										max: maxCalls,
										className: "bg-muted",
									}),
									truncatedText(h, {
										text: op.spanName,
										mono: true,
										className: "relative flex-1 text-xs text-foreground",
									}),
									hstack(
										h,
										{
											gap: "3",
											align: "center",
											as: "span",
											className: "relative shrink-0 font-mono text-2xs tabular-nums",
										},
										[
											typography(h, { tone: "foreground" }, [
												...(op.estimatedSpanCount > op.spanCount ? ["~"] : []),
												formatThroughput(
													callsPerSecond(op.estimatedSpanCount, seconds),
													"/s",
												),
											]),
											errorRateValue(h, { rate: op.errorRate }),
											latencyValue(h, { ms: op.p95DurationMs, scale: "p95" }),
										],
									),
									h.div(
										[h.Class("relative hidden shrink-0 sm:block")],
										[
											h.submodel({
												slotId: `op-spark-${op.spanName}`,
												model: SPARKLINE_MODEL,
												view: Sparkline.view,
												viewInputs: {
													chartId: `op-${op.spanName}`,
													values: Arr.map(op.sparkline, (point) => point.count),
													color,
													className: "h-5 w-24",
													revision: 0,
													fillOpacity: [0.5, 0.1],
												},
												toParentMessage: toSparkline,
											}),
										],
									),
								],
							),
						],
					),
				),
			),
		],
	)
}
