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

/**
 * WarpStream clusters are scraped as Prometheus targets and cannot be told apart from other ones,
 * so its step is done once a target is added in this visit, not when any Prometheus target exists.
 */
export const isIntegrationConnected = (model: Model, integration: DataIntegration): boolean =>
	integration === "warpstream"
		? model.hasAddedTarget
		: overviewOf(model.integrations.statuses, model.integrations.nowMs, integration)?.kind === "connected"

/** The sources an integration feeds. */
const sourcesOfIntegration = (
	model: Model,
	integration: Exclude<DataIntegration, "warpstream">,
): ReadonlyArray<V2Source> =>
	AsyncData.getOrElse(model.list.data, (): ReadonlyArray<V2Source> => []).filter(
		(source) => source.platform === integration,
	)

/** Once connected, one source opens directly; several (accounts, targets) open the list. */
const connectedNotice = (h: H, model: Model, integration: DataIntegration): Html => {
	// A WarpStream target is one Prometheus source among others: the list, not a guess at which.
	const sources = integration === "warpstream" ? [] : sourcesOfIntegration(model, integration)
	const only = sources.length === 1 ? sources[0] : undefined
	// Added is not collecting: until the integration reads healthy, the notice says what is left.
	const overview =
		integration === "warpstream"
			? null
			: overviewOf(model.integrations.statuses, model.integrations.nowMs, integration)
	const pending = overview?.kind === "connected" && overview.health !== "healthy" ? overview : null
	const label = integrationMeta(integration).label
	return alert(h, { variant: pending === null ? "ok" : "warn" }, [
		icon(h, pending === null ? "CircleCheckIcon" : "CircleWarningIcon"),
		alertTitle(h, pending === null ? [label, " is connected"] : [label, " is added, not collecting yet"]),
		alertDescription(h, [
			pending === null
				? "Each account or target it collects from shows up as its own source."
				: `${pending.issue ?? pending.stateLabel}. Finish the steps below; until then it sends nothing.`,
		]),
		alertAction(h, [
			only === undefined
				? linkButton(h, { size: "sm", variant: "outline", href: hrefOf(AppRoute.Sources()) }, [
						"View sources",
					])
				: linkButton(h, { size: "sm", variant: "outline", href: sourceHref(only, "connection") }, [
						"Open source",
					]),
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
