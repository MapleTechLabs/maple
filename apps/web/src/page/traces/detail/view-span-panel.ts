import * as SpanPanel from "@maple/views/traces/span-panel"
import type { Html, HtmlBuilder } from "foldkit/html"
import { getActiveInfraCorrelations } from "../../../components/infra/infra-correlations"
import { docsUrl } from "../../../lib/docs"
import * as InfraCorrelation from "../../kit/infra-correlation"
import { Message } from "./message"
import type { Model } from "./model"

// The shared span panel as this page embeds it: filterable attributes, the docs link, and the
// Infrastructure tab when the span's resource names a pod, node, container or host.

const infraTab = (
	h: HtmlBuilder<Message>,
	panel: SpanPanel.Model,
	infra: InfraCorrelation.Model,
	timeZone: string,
): (() => Html) | undefined => {
	const resourceAttributes = SpanPanel.resourceAttributesOf(panel)
	if (getActiveInfraCorrelations({ ...resourceAttributes }).length === 0) return undefined
	return () =>
		h.submodel({
			slotId: `${infra.id}-panel`,
			model: infra,
			view: InfraCorrelation.view,
			viewInputs: {
				resourceAttributes,
				anchor: panel.span.startTime,
				spanDurationMs: panel.span.durationMs,
				timeZone,
			},
			toParentMessage: (message) => Message.GotSpanInfraMessage({ message }),
		})
}

/** The span panel for the selected span, or nothing while none is selected. */
export const spanPanelSubmodel = (
	h: HtmlBuilder<Message>,
	model: Model,
	slotId: string,
	timeZone: string,
): Html | null => {
	const panel = model.spanPanel
	if (panel === null) return null
	return h.submodel({
		slotId,
		model: panel,
		view: SpanPanel.view,
		viewInputs: {
			timeZone,
			canFilterAttributes: true,
			logsDocsHref: docsUrl("logs"),
			infraTab: model.spanInfra === null ? undefined : infraTab(h, panel, model.spanInfra, timeZone),
		},
		toParentMessage: (message: SpanPanel.Message) => Message.GotSpanPanelMessage({ message }),
	})
}
