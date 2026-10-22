import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "../../../../charts/theme-colors"
import { errorState } from "../../../../ui/error-state"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import * as Frame from "../../kit/frame"
import { INFRA_CHART_TOKENS } from "../../../../charts/infra-metric-series"
import { resourceAttributesCardSkeleton } from "../../kit/resource-attributes"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import { hostDetailHeader, hostDetailHeaderLoading } from "./view-header"
import { hostMetadataPanel, metricsPanel } from "./view-panels"

// `HostDetailPage`.

type H = HtmlBuilder<Message>

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })

const header = (h: H, model: Model, inputs: PageViewInputs): Html =>
	AsyncData.matchData(model.summary.data, {
		onEmpty: () => hostDetailHeaderLoading(h),
		onFailure: (failure) =>
			errorState(h, {
				variant: "inline",
				failure,
				title: "Failed to load host summary",
				onRetry: Message.ClickedRetrySummary(),
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
const rightPanel = (h: H, model: Model, inputs: PageViewInputs): Html | undefined => {
	const data = model.summary.data
	const summary = AsyncData.getOrElse(data, () => null)
	if (summary !== null)
		return hostMetadataPanel(h, model, summary, model.frame.nowMs, inputs.context.timeZone)
	return AsyncData.isLoading(data) || AsyncData.isIdle(data)
		? resourceAttributesCardSkeleton(h, "ServerIcon")
		: undefined
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: INFRA_CHART_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					actions: Frame.controls(
						h,
						model.frame,
						{ search: model.search, defaultPreset: DEFAULT_PRESET },
						toFrame,
					),
					rightPanel: rightPanel(h, model, inputs),
				},
				[
					h.div(
						[h.Class("space-y-8")],
						[header(h, model, inputs), metricsPanel(h, model, inputs.context.timeZone)],
					),
				],
			),
		],
	),
)
