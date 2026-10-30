import { formatThroughput } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import * as Sparkline from "../../../charts/sparkline"
import { resolveColor, type ThemeColors } from "../../../charts/theme-colors"
import { backdropBar } from "../../../ui/meter"
import { panel, panelBody, panelHeader } from "../../../ui/panel"
import { truncatedText } from "../../../ui/truncated-text"
import { errorRateValue, latencyValue } from "../../../ui/values"
import { callsPerSecond, windowSeconds } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

// The Overview tab's quiet panels.

type H = HtmlBuilder<Message>

export const SPARKLINE_TOKEN = "var(--chart-1)"

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
	h.button(
		[
			h.Type("button"),
			h.OnClick(onClick),
			h.Class(
				"text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
			),
		],
		["View all →"],
	)

const PANEL_LIMIT = 5
const SPARKLINE_MODEL = Chart.init()
const toSparkline = (message: Chart.Message) => Message.GotChartMessage({ chartId: "sparkline", message })

/** `ServiceTopOperationsPanel`: nothing while loading or empty, five rows otherwise. */
export const topOperationsPanel = (h: H, model: Model, theme: ThemeColors | null): Html => {
	const operations = AsyncData.getOrElse(model.operations.data, () => []).slice(0, PANEL_LIMIT)
	if (operations.length === 0 || model.window === null) return null
	const seconds = windowSeconds(model.window)
	const maxCalls = operations.reduce((acc, op) => Math.max(acc, op.estimatedSpanCount), 0)
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
			h.ul(
				[h.Class("divide-y")],
				operations.map((op) =>
					h.li(
						[h.Key(op.spanName)],
						[
							h.button(
								[
									h.Type("button"),
									h.OnClick(onViewAll),
									h.Class(
										"relative flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
									),
								],
								[
									backdropBar(h, {
										value: op.estimatedSpanCount,
										max: maxCalls,
										className: "bg-severity-info/10",
									}),
									truncatedText(h, {
										text: op.spanName,
										mono: true,
										className: "relative flex-1 text-xs text-foreground",
									}),
									h.span(
										[
											h.Class(
												"relative flex shrink-0 items-center gap-3 font-mono text-2xs tabular-nums",
											),
										],
										[
											h.span(
												[h.Class("text-foreground")],
												[
													...(op.estimatedSpanCount > op.spanCount ? ["~"] : []),
													formatThroughput(
														callsPerSecond(op.estimatedSpanCount, seconds),
														"/s",
													),
												],
											),
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
													values: op.sparkline.map((point) => point.count),
													color,
													className: "h-5 w-[88px]",
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
