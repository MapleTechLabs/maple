import { parseWarehouseDateTime } from "@maple/query-engine"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { isChartRuntimeReady } from "@maple/views/charts/chart-runtime"
import { errorState } from "@maple/views/ui/error-state"
import type { PageContext } from "../../contract"
import { environmentsOf, ISSUES_DETAIL_LIMIT_MS } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { metricsGrid } from "./view-charts"
import {
	type DeployCheck,
	dataEndOf,
	deployBefore,
	deployChecksOf,
	deployDataEndOf,
	isSameDeploy,
} from "./derive-deploys"
import * as DeployPeekView from "./deploy-peek/view"
import { deployPeekOf } from "./update"
import { Array as Arr } from "effect"
import { deploysPanel, issuesPanel } from "./view-deploys"
import { footprintPanel } from "./view-footprint"
import { deployCallout, healthStrip } from "./view-health"
import { SPARKLINE_TOKEN, topOperationsPanel } from "./view-panels"
import { uptimePanel } from "./view-uptime"
import { sourceMapsPanel } from "./view-source-maps"
import { vstack } from "@maple/views/ui/stack"
import { grid } from "@maple/views/ui/grid"
import { CHART_TOKENS } from "../../kit/service-metrics/grid"

// The Overview tab, in triage order: the deploy that needs a look, the signals now, the charts,
// what broke and what shipped, the busiest operations, then uptime, source maps and where the
// service runs.

type H = HtmlBuilder<Message>

/** Every colour the tab's canvases read off the theme. */
export const THEME_TOKENS = [...CHART_TOKENS, SPARKLINE_TOKEN]

/** The deploy drawer over the Overview; it gives the open deploy the issues the tags give it. */
const deployDrawer = (
	h: H,
	model: Model,
	context: PageContext,
	deploys: ReadonlyArray<DeployCheck>,
): Html => {
	const check = deployPeekOf(model)
	const issues = AsyncData.getOrElse(model.issues.data, () => [])
	return h.submodel({
		slotId: "deploy-peek",
		model: model.deployPeek,
		view: DeployPeekView.view,
		viewInputs: {
			check,
			serviceName: model.serviceName,
			commit: check === null ? undefined : model.commits[check.sha],
			issues:
				check === null
					? []
					: Arr.filter(issues, (issue) =>
							isSameDeploy(
								deployBefore(
									deploys,
									parseWarehouseDateTime(issue.firstSeenAt),
									deployDataEndOf(model),
								),
								check,
							),
						),
			dataEndMs: dataEndOf(model),
			nowMs: model.nowMs ?? 0,
			timeZone: context.timeZone,
			timeSearch: {
				startTime: model.search.startTime,
				endTime: model.search.endTime,
				timePreset: model.search.timePreset,
			},
		},
		toParentMessage: (message) => Message.GotDeployPeekMessage({ message }),
	})
}

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
	const deploys = deployChecksOf(model)
	// The optional cards share one two-column row; alone, a card takes the full width.
	const sideCards = Arr.filter(
		[uptimePanel(h, model), sourceMapsPanel(h, model, clock), footprintPanel(h, model, envFilterActive)],
		(card) => card !== null,
	)
	return vstack(h, { gap: "3" }, [
		deployCallout(h, model, deploys),
		healthStrip(h, model, isDetailLoading),
		metricsGrid(
			h,
			model,
			{
				isLoading: isDetailLoading || !isChartReady,
				isWaiting: AsyncData.isRefreshing(overview),
				context:
					model.themeColors === null
						? null
						: { theme: model.themeColors, timeZone: context.timeZone, nowMs },
			},
			context.timeZone,
		),
		grid(h, { lg: 2, gap: "3" }, [
			issuesPanel(h, model, clock, isLimited, deploys),
			deploysPanel(h, model, clock),
		]),
		topOperationsPanel(h, model, model.themeColors),
		sideCards.length <= 1 ? (sideCards[0] ?? null) : grid(h, { lg: 2, gap: "3" }, sideCards),
		deployDrawer(h, model, context, deploys),
	])
}
