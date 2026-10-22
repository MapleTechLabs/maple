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
import { navShell } from "../settings/kit/nav-shell"
import { isClerkAuthEnabled } from "../../lib/services/common/auth-mode"
import { visibleSections } from "../settings/nav"
import { settingsNavVisibility } from "./derive"
import { entryGlyph } from "./view-entry"
import { chatCard } from "./view-chat-card"
import { cloudflareCard, cloudflareHeaderActions } from "./view-cloudflare"
import { gcpCard, gcpHeaderStatus } from "./view-gcp"
import { githubCard } from "./view-github"
import { hazelCard } from "./view-hazel"
import { planetscaleCard } from "./view-planetscale"
import { railwayCard } from "./view-railway"
import { supabaseCard } from "./view-supabase"
import { scrapeIntro, scrapeTargetsSection } from "./view-prometheus"
import { integrationHeader } from "./view-header"
import { integrationCatalog, integrationsSummary } from "./view-hub"

// `IntegrationsPage`.

type H = HtmlBuilder<Message>

const selectIntegration = (id: IntegrationId) => Message.ClickedIntegration({ integration: id })

/** The header's Connect button for an OAuth integration (`useIntegrationConnect()`). */
export const connectButton = (h: H, model: Model, integration: IntegrationId): Html | undefined => {
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
export const cardView = (
	h: H,
	model: Model,
	integration: IntegrationId,
	timeZone: string,
	focusId: string | null = null,
): ReadonlyArray<Html> => {
	const connector = chatConnectorOf(integration)
	if (connector !== null) return [chatCard(h, model, connector, timeZone)]
	switch (integration) {
		case "hazel":
			return [hazelCard(h, model)]
		case "github":
			return githubCard(h, model, timeZone)
		case "cloudflare":
			return [cloudflareCard(h, model, timeZone)]
		case "railway":
			return [railwayCard(h, model, timeZone)]
		case "supabase":
			return [supabaseCard(h, model, timeZone)]
		case "planetscale":
			return [planetscaleCard(h, model, timeZone)]
		case "gcp":
			return [gcpCard(h, model, timeZone, focusId)]
		case "prometheus":
		case "warpstream":
			return focusId === null
				? [scrapeIntro(h, integration), ...scrapeTargetsSection(h, model, timeZone)]
				: scrapeTargetsSection(h, model, timeZone, focusId)
		default:
			return []
	}
}

const detailView = (h: H, model: Model, integration: IntegrationId, timeZone: string): Html =>
	dashboardPage(
		h,
		{
			filters: settingsNav(h, model),
			titleContent: integrationHeader(h, model, integration, {
				connect: connectButton(h, model, integration),
				actions: integration === "cloudflare" ? cloudflareHeaderActions(h, model) : undefined,
				statusLine: integration === "gcp" ? gcpHeaderStatus(h, model) : undefined,
			}),
			scrollClassName: "gap-4",
		},
		cardView(h, model, integration, timeZone),
	)

/** The settings rail with "Integrations" the active link, gated like `/settings`. */
const settingsNav = (h: HtmlBuilder<Message>, model: Model): Html =>
	navShell(
		h,
		visibleSections(settingsNavVisibility(model, isClerkAuthEnabled)),
		"integrations",
		(tab) => Message.ClickedSettingsTab({ tab }),
	)

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const integration = integrationOfSearch(model.search.integration)
	return integration === null
		? dashboardPage(
				h,
				{
					filters: settingsNav(h, model),
					actions: integrationsSummary(h, model) ?? h.empty,
				},
				[integrationCatalog(h, model, selectIntegration)],
			)
		: detailView(h, model, integration, inputs.context.timeZone)
})
