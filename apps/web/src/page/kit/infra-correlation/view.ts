import { getActiveInfraCorrelations, type InfraCorrelation } from "../../../components/infra/infra-correlations"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { INFRA_CHART_TOKENS } from "../../../charts/infra-metric-series"
import { LINKED_CURSOR_STYLE } from "../../../charts/linked-cursor"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../route"
import { emptyMessage } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { truncatedText } from "../../../ui/truncated-text"
import { docsLink } from "../signal-empty-state"
import { type Message, type Model } from "./model"
import { correlationCharts } from "./view-charts"
import { MountInfraCorrelation } from "./window"

type H = HtmlBuilder<Message>

export type ViewInputs = Readonly<{
	resourceAttributes: Readonly<Record<string, string>>
	/** The log's timestamp or the span's start, and the span's duration (0 for a log). */
	anchor: string
	spanDurationMs: number
	timeZone: string
}>

const LINK_CLASS =
	"inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-2xs text-muted-foreground hover:text-foreground active:text-foreground"

/** `CorrelationLink`: the matching infra detail route, per kind. */
const correlationHref = (correlation: InfraCorrelation): string => {
	switch (correlation.kind) {
		case "container":
			return hrefOf(
				AppRoute.InfraContainer({
					containerName: correlation.identifier,
					search: correlation.hostName ? { host: correlation.hostName } : {},
				}),
			)
		case "pod":
			return hrefOf(
				AppRoute.InfraKubernetesPod({
					podName: correlation.identifier,
					search: correlation.namespace ? { namespace: correlation.namespace } : {},
				}),
			)
		case "node":
			return hrefOf(AppRoute.InfraKubernetesNode({ nodeName: correlation.identifier, search: {} }))
		case "host":
			return hrefOf(AppRoute.InfraHost({ hostName: correlation.identifier, search: {} }))
	}
}

const section = (h: H, model: Model, correlation: InfraCorrelation, timeZone: string): Html =>
	h.section(
		[h.Key(`${correlation.kind}:${correlation.identifier}`), h.Class("space-y-2")],
		[
			h.div(
				[h.Class("space-y-0.5")],
				[
					h.div(
						[h.Class("flex items-center justify-between gap-2")],
						[
							h.span([h.Class("text-xs font-medium text-foreground")], [correlation.title]),
							h.a(
								[h.Href(correlationHref(correlation)), h.Class(LINK_CLASS)],
								["View in Infrastructure", icon(h, "ExternalLinkIcon", { size: 12 })],
							),
						],
					),
					truncatedText(h, { text: correlation.identifier, mono: true, className: "text-2xs text-muted-foreground" }),
				],
			),
			correlationCharts(h, model, correlation, timeZone),
		],
	)

const noCorrelation = (h: H): Html =>
	emptyMessage(h, { dashed: true, className: "flex flex-col items-center gap-2 py-12" }, [
		h.p([], ["No Kubernetes, container, or host metadata on this record."]),
		h.p(
			[h.Class("text-xs")],
			["Set host.name, container.id or k8s.pod.name as resource attributes to link records to infrastructure."],
		),
		docsLink(h, "otelConventions"),
	])

/** The panel; keyed by the record, so another record remounts it and reads its own window. */
export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const correlations = getActiveInfraCorrelations({ ...inputs.resourceAttributes })
	if (correlations.length === 0) return noCorrelation(h)
	const identity = correlations.map((correlation) => `${correlation.kind}:${correlation.identifier}`).join("|")
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: INFRA_CHART_TOKENS }))],
		[
			h.div(
				[
					h.Key(`${inputs.anchor}|${identity}`),
					h.Class("space-y-6"),
					h.Style(LINKED_CURSOR_STYLE),
					h.OnMount(
						MountInfraCorrelation({
							anchor: inputs.anchor,
							spanDurationMs: inputs.spanDurationMs,
							timeZone: inputs.timeZone,
							resourceAttributes: { ...inputs.resourceAttributes },
						}),
					),
				],
				correlations.map((correlation) => section(h, model, correlation, inputs.timeZone)),
			),
		],
	)
})
