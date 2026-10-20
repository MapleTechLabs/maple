import { Schema } from "effect"
import { DATA_INTEGRATIONS } from "../../route/data-integrations"
import { Submodel } from "foldkit"
import { icon } from "../../ui/icon"
import type { PageContext, PageReturn } from "../contract"
import { catalogEntry, type IntegrationId } from "./catalog"
import { overviewOf } from "./derive"
import type { Message } from "./message"
import type { Model } from "./model"
import { init } from "./update"
import { cardView, connectButton } from "./view"
import { cloudflareHeaderActions } from "./view-cloudflare"

// The integrations page module, embedded by Sources: the connect step and a source's Connection tab.

export { DATA_INTEGRATIONS }
export const DataIntegration = Schema.Literals(DATA_INTEGRATIONS)
export type DataIntegration = typeof DataIntegration.Type
export const isDataIntegration = Schema.is(DataIntegration)

/** `/integrations?integration=<id>`'s state and reads, without the page around it. */
export const initEmbedded = (
	integration: DataIntegration | null,
	context: PageContext,
): PageReturn<Model, Message> => init({ search: integration === null ? {} : { integration } }, context)

export type EmbedInputs = Readonly<{
	integration: IntegrationId
	timeZone: string
	/** The integration record a source stands for (`integration_id`): its card shows only that one. */
	focusId?: string | null
}>

/** The integration's card: its connect empty state, or what it collects once connected. */
export const cardEmbed = Submodel.defineView<Model, Message, EmbedInputs>((model, inputs, h) =>
	h.div([h.Class("flex flex-col gap-4")], [...cardView(h, model, inputs.integration, inputs.timeZone, inputs.focusId ?? null)]),
)

/** The header's Docs link, the Connect button while available, Cloudflare's Reconnect and Disconnect. */
export const actionsEmbed = Submodel.defineView<Model, Message, EmbedInputs>((model, inputs, h) => {
	const entry = catalogEntry(inputs.integration)
	const overview = overviewOf(model.statuses, model.nowMs, inputs.integration)
	const connect = overview?.kind === "available" ? connectButton(h, model, inputs.integration) : undefined
	const actions =
		overview?.kind === "connected" && inputs.integration === "cloudflare"
			? cloudflareHeaderActions(h, model)
			: []
	return h.div(
		[h.Class("flex shrink-0 items-center gap-3")],
		[
			...(entry.docsUrl === undefined
				? []
				: [
						h.a(
							[
								h.Href(entry.docsUrl),
								h.Target("_blank"),
								h.Rel("noreferrer"),
								h.Class(
									"inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground",
								),
							],
							["Docs", icon(h, "ExternalLinkIcon", { size: 12 })],
						),
					]),
			...actions,
			...(connect === undefined ? [] : [connect]),
		],
	)
})
