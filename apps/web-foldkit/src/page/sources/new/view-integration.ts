import type { V2Source } from "@maple/domain/http/v2"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { alert, alertAction, alertDescription, alertTitle } from "../../../ui/alert"
import { linkButton } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import { cardEmbed, type DataIntegration } from "../../integrations/embed"
import { overviewOf } from "../../integrations/derive"
import { sourceHref } from "../kit/shared"
import { Message } from "./message"
import type { Model } from "./model"
import { integrationMeta } from "./view-picker"

// `/sources/new?integration=`: the integration's own card as step 2, the source it creates as step 3.

type H = HtmlBuilder<Message>

export const isIntegrationConnected = (model: Model, integration: DataIntegration): boolean =>
	overviewOf(model.integrations.statuses, model.integrations.nowMs, integration)?.kind === "connected"

/** The sources an integration feeds: WarpStream targets are Prometheus sources. */
export const sourcesOfIntegration = (model: Model, integration: DataIntegration): ReadonlyArray<V2Source> => {
	const platform = integration === "warpstream" ? "prometheus" : integration
	return AsyncData.getOrElse(model.list.data, (): ReadonlyArray<V2Source> => []).filter(
		(source) => source.platform === platform,
	)
}

/** Once connected, one source opens directly; several (accounts, targets) open the list. */
const connectedNotice = (h: H, model: Model, integration: DataIntegration): Html => {
	const sources = sourcesOfIntegration(model, integration)
	const only = sources.length === 1 ? sources[0] : undefined
	return alert(h, { variant: "ok" }, [
		icon(h, "CircleCheckIcon"),
		alertTitle(h, [integrationMeta(integration).label, " is connected"]),
		alertDescription(h, ["Each account or target it collects from shows up as its own source."]),
		alertAction(h, [
			only === undefined
				? linkButton(h, { size: "sm", variant: "outline", href: hrefOf(AppRoute.Sources()) }, ["View sources"])
				: linkButton(h, { size: "sm", variant: "outline", href: sourceHref(only, "connection") }, ["Open source"]),
		]),
	])
}

export const integrationStep = (h: H, model: Model, integration: DataIntegration, timeZone: string): Html =>
	h.div(
		[h.Class("flex flex-col gap-4")],
		[
			h.button(
				[
					h.Type("button"),
					h.OnClick(Message.ClickedBack()),
					h.Class(
						"text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1.5 text-xs",
					),
				],
				[icon(h, "ArrowLeftIcon", { size: 12 }), "Pick another source"],
			),
			...(isIntegrationConnected(model, integration) ? [connectedNotice(h, model, integration)] : []),
			h.submodel({
				slotId: "sources-new-integration",
				model: model.integrations,
				view: cardEmbed,
				viewInputs: { integration, timeZone },
				toParentMessage: (message) => Message.GotIntegrationsMessage({ message }),
			}),
		],
	)
