import { parseWarehouseDateTime } from "@maple/query-engine"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { isChartRuntimeReady } from "../../../charts/chart-runtime"
import { errorState } from "../../../ui/error-state"
import type { PageContext } from "../../contract"
import { environmentsOf, ISSUES_DETAIL_LIMIT_MS } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { CHART_TOKENS, metricsGrid } from "./view-charts"
import { deploysPanel, issuesPanel } from "./view-deploys"
import { dependencyStrip, usagePanel, workloadsPanel } from "./view-footprint"
import { SPARKLINE_TOKEN, topOperationsPanel } from "./view-panels"
import { uptimePanel } from "./view-uptime"

// The Overview tab: the chart grid, then the quiet panels and the "Talks to" strip.

type H = HtmlBuilder<Message>

/** Every colour the tab's canvases read off the theme. */
export const THEME_TOKENS = [...CHART_TOKENS, SPARKLINE_TOKEN]

export const overviewTab = (h: H, model: Model, context: PageContext): Html => {
	const overview = model.overview.data
	if (AsyncData.isFailure(overview)) {
		return errorState(h, {
			failure: overview.error,
			title: "Couldn't load service overview",
			onRetry: Message.ClickedRetry({ target: "Overview" }),
		})
	}
	const isDetailLoading = AsyncData.isIdle(overview) || AsyncData.isLoading(overview)
	const nowMs = model.nowMs ?? 0
	const isChartReady = model.themeColors !== null && isChartRuntimeReady(model.chartRuntime)
	const environments = environmentsOf(model.search)
	const envFilterActive = environments !== undefined
	const window = model.window
	const isLimited =
		window !== null &&
		parseWarehouseDateTime(window.endTime) - parseWarehouseDateTime(window.startTime) >
			ISSUES_DETAIL_LIMIT_MS
	const clock = { nowMs, timeZone: context.timeZone }
	return h.div(
		[h.Class("flex flex-col gap-3")],
		[
			metricsGrid(h, model, {
				isLoading: isDetailLoading || !isChartReady,
				isWaiting: AsyncData.isRefreshing(overview),
				context:
					model.themeColors === null
						? null
						: { theme: model.themeColors, timeZone: context.timeZone, nowMs },
			}),
			topOperationsPanel(h, model, model.themeColors),
			h.div(
				[h.Class("grid gap-3 lg:grid-cols-2")],
				[
					issuesPanel(h, model, clock, isLimited),
					deploysPanel(h, model, clock, isDetailLoading),
					usagePanel(h, model, envFilterActive),
					uptimePanel(h, model),
					workloadsPanel(h, model, envFilterActive),
				],
			),
			dependencyStrip(h, model),
		],
	)
}
