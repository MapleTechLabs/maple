import { Schema } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { PageViewInputs } from "../contract"
import { dashboardPage } from "../kit/dashboard-page"
import { button } from "../../ui/button"
import { catalogEntry, chatConnectorOf, integrationOfSearch, type IntegrationId } from "./catalog"
import { ConnectProvider } from "./connect"
import { Message } from "./message"
import type { Model } from "./model"
import { settingsNav } from "./settings-nav"
import { entryGlyph } from "./view-entry"
import { chatCard } from "./view-chat-card"
import { cloudflareCard, cloudflareHeaderActions } from "./view-cloudflare"
import { githubCard } from "./view-github"
import { hazelCard } from "./view-hazel"
import { integrationHeader } from "./view-header"
import { integrationCatalog, integrationsSummary } from "./view-hub"

// `IntegrationsPage` (apps/web/src/routes/integrations.tsx).

type H = HtmlBuilder<Message>

const selectIntegration = (id: IntegrationId) => Message.ClickedIntegration({ integration: id })

/** The header's Connect button for an OAuth integration (`useIntegrationConnect()`). */
const connectButton = (h: H, model: Model, integration: IntegrationId): Html | undefined => {
	if (!Schema.is(ConnectProvider)(integration)) return undefined
	const entry = catalogEntry(integration)
	return button(
		h,
		{
			size: "sm",
			isLoading: model.connect.isStarting,
			attributes: [h.OnClick(Message.ClickedConnect())],
		},
		[entryGlyph(h, entry, undefined), "Connect ", entry.name],
	)
}

/** The integration's own card under the header. */
const cardView = (h: H, model: Model, integration: IntegrationId, timeZone: string): ReadonlyArray<Html> => {
	const connector = chatConnectorOf(integration)
	if (connector !== null) return [chatCard(h, model, connector, timeZone)]
	switch (integration) {
		case "hazel":
			return [hazelCard(h, model)]
		case "github":
			return githubCard(h, model, timeZone)
		case "cloudflare":
			return [cloudflareCard(h, model, timeZone)]
		default:
			return []
	}
}

const detailView = (h: H, model: Model, integration: IntegrationId, timeZone: string): Html =>
	dashboardPage(
		h,
		{
			filters: settingsNav(h, (tab) => Message.ClickedSettingsTab({ tab })),
			titleContent: integrationHeader(h, model, integration, {
				connect: connectButton(h, model, integration),
				actions: integration === "cloudflare" ? cloudflareHeaderActions(h, model) : undefined,
			}),
			scrollClassName: "gap-4",
		},
		cardView(h, model, integration, timeZone),
	)

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const integration = integrationOfSearch(model.search.integration)
	return integration === null
		? dashboardPage(
				h,
				{
					filters: settingsNav(h, (tab) => Message.ClickedSettingsTab({ tab })),
					actions: integrationsSummary(h, model) ?? h.empty,
				},
				[integrationCatalog(h, model, selectIntegration)],
			)
		: detailView(h, model, integration, inputs.context.timeZone)
})
