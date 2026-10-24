import type { V2Source } from "@maple/domain/http/v2"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import { type DataIntegration, flowEmbed } from "../../integrations/embed"
import { canContinue, type FlowSpec } from "../../integrations/flow"
import { sourceHref } from "../kit/shared"
import { Message } from "./message"
import type { Model } from "./model"
import { flowSpecOf } from "./update"

// `/sources/new?integration=`: the integration's current step, then the footer that moves between them.

type H = HtmlBuilder<Message>

/** The sources an integration feeds. */
const sourcesOfIntegration = (model: Model, integration: DataIntegration): ReadonlyArray<V2Source> =>
	integration === "warpstream"
		? []
		: AsyncData.getOrElse(model.list.data, (): ReadonlyArray<V2Source> => []).filter(
				(source) => source.platform === integration,
			)

/** Go live's way out: one source opens directly; several (accounts, targets) open the list. */
const openSource = (h: H, model: Model, integration: DataIntegration): Html => {
	const sources = sourcesOfIntegration(model, integration)
	const only = sources.length === 1 ? sources[0] : undefined
	return only === undefined
		? linkButton(h, { variant: "outline", href: hrefOf(AppRoute.Sources()) }, ["View sources"])
		: linkButton(h, { variant: "outline", href: sourceHref(only, "connection") }, ["Open source"])
}

const footer = (h: H, model: Model, integration: DataIntegration, spec: FlowSpec): Html =>
	h.footer(
		[
			h.Class(
				"sticky bottom-0 -mx-1 mt-2 flex items-center justify-between gap-4 border-t border-border bg-background px-1 py-4",
			),
		],
		[
			button(h, { variant: "outline", attributes: [h.OnClick(Message.ClickedStepBack())] }, [
				icon(h, "ArrowLeftIcon", { size: 14 }),
				"Back",
			]),
			h.div(
				[h.Class("flex items-center gap-4")],
				[
					h.span(
						[h.Class("hidden text-xs text-muted-foreground @2xl/page:inline")],
						[spec.hint[model.stage]],
					),
					model.stage === "live"
						? openSource(h, model, integration)
						: button(
								h,
								{
									isDisabled: !canContinue(spec, model.stage),
									attributes: [h.OnClick(Message.ClickedContinue())],
								},
								["Continue", icon(h, "ArrowRightIcon", { size: 14 })],
							),
				],
			),
		],
	)

export const integrationStep = (h: H, model: Model, integration: DataIntegration, timeZone: string): Html => {
	const spec = flowSpecOf(model)
	return h.div(
		[h.Class("flex flex-col gap-4")],
		[
			h.submodel({
				slotId: "sources-new-integration",
				model: model.integrations,
				view: flowEmbed,
				viewInputs: { integration, stage: model.stage, timeZone },
				toParentMessage: (message) => Message.GotIntegrationsMessage({ message }),
			}),
			...(spec === null ? [] : [footer(h, model, integration, spec)]),
		],
	)
}
