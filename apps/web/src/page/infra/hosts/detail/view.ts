import { AsyncData } from "foldkit"
import type { Html } from "foldkit/html"
import { ResolveThemeColors } from "../../../../charts/theme-colors"
import { errorState } from "../../../../ui/error-state"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import * as Frame from "../../kit/frame"
import { pageHeroParts, headerActions } from "../../kit/page-parts"
import { INFRA_CHART_TOKENS } from "../../../../charts/infra-metric-series"
import { resourceAttributesCardSkeleton } from "../../kit/resource-attributes"
import { FrameBinding, HostDetailComposition, type HostDetailViewBuilder } from "./composition"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import { type HostHeaderParts, hostDetailHeader, hostDetailHeaderLoading } from "./view-header"
import { hostMetadataPanel, metricsPanel } from "./view-panels"

// `HostDetailPage`.

type H = HostDetailViewBuilder

/** What the page reads from the root: data only, as Block view inputs carry no callbacks. */
export type HostDetailViewInputs = PageViewInputs

const header = (h: H, model: Model, inputs: HostDetailViewInputs): HostHeaderParts =>
	AsyncData.matchData(model.summary.data, {
		onEmpty: () => hostDetailHeaderLoading(h),
		onFailure: (failure) => ({
			title: pageHeroParts(h, { title: h.span([h.Class("font-mono")], [model.hostName]) }).title,
			actions: [],
			body: errorState(h, {
				variant: "inline",
				failure,
				title: "Couldn't load host summary",
				onRetry: Message.ClickedRetrySummary(),
			}),
		}),
		onData: (summary) =>
			hostDetailHeader(h, {
				summary,
				hostName: model.hostName,
				nowMs: model.frame.nowMs,
				timeZone: inputs.context.timeZone,
				canWiden: Frame.canWidenTimeRange(model.search, DEFAULT_PRESET),
			}),
	})

/** The right rail: the summary's attributes, a skeleton while it first loads, nothing otherwise. */
const rightPanel = (h: H, model: Model, inputs: HostDetailViewInputs): Html | undefined => {
	const data = model.summary.data
	const summary = AsyncData.getOrElse(data, () => null)
	if (summary !== null)
		return hostMetadataPanel(h, model, summary, model.frame.nowMs, inputs.context.timeZone)
	return AsyncData.isLoading(data) || AsyncData.isIdle(data)
		? resourceAttributesCardSkeleton(h, "ServerIcon")
		: undefined
}

export const view = HostDetailComposition.makeView.withInputs<HostDetailViewInputs>((model, inputs, h) => {
	const hero = header(h, model, inputs)
	const timeControls = h.block(
		FrameBinding.embedView({
			slotId: "infra-time-frame",
			model: model.frame,
			viewInputs: { search: model.search, defaultPreset: DEFAULT_PRESET },
		}),
	)
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: INFRA_CHART_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					titleContent: hero.title,
					actions: headerActions(h, hero.actions, timeControls),
					rightPanel: rightPanel(h, model, inputs),
				},
				[h.div([h.Class("space-y-8")], [hero.body, metricsPanel(h, model, inputs.context.timeZone)])],
			),
		],
	)
})
