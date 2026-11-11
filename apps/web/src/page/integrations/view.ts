import { Schema } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { PageViewInputs } from "../contract"
import { dashboardPage } from "../kit/dashboard-page"
import { button } from "@maple/views/ui/button"
import {
	type CatalogEntry,
	catalogEntry,
	chatConnectorOf,
	entryOfSearch,
	type IntegrationId,
} from "./catalog"
import { ConnectProvider } from "./connect"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { navShell } from "../kit/nav-shell"
import { isClerkAuthEnabled } from "../../platform/auth-mode"
import { visibleSections } from "../settings/nav"
import { settingsNavVisibility } from "./derive"
import { entryGlyph } from "./view-entry"
import { chatCard } from "./view-chat-card"
import {
	cloudflareCard,
	cloudflareHeaderActions,
} from "../infra-integrations/cloudflare/integration/view-cloudflare"
import { gcpCard, gcpHeaderStatus } from "../infra-integrations/gcp/integration/view-gcp"
import { githubCard } from "./view-github"
import { linearCard } from "./view-linear"
import { searchConsoleCard } from "./view-search-console"
import { planetscaleCard } from "../infra-integrations/planetscale/integration/view-planetscale"
import { railwayCard } from "../infra-integrations/railway/integration/view-railway"
import {
	vercelCard,
	vercelHeaderActions,
	vercelHeaderStatus,
} from "../infra-integrations/vercel/integration/view-vercel"
import { awsCard } from "../infra-integrations/aws/integration/view-aws"
import { supabaseCard } from "../infra-integrations/supabase/integration/view-supabase"
import { scrapeIntro, scrapeTargetsSection } from "./view-prometheus"
import { integrationHeader } from "./view-header"
import { hubTitle, integrationCatalog, integrationsSummary } from "./view-hub"

type H = HtmlBuilder<Message>

const selectIntegration = (id: IntegrationId) => Message.ClickedIntegration({ integration: id })

/** The header's Connect button for an OAuth integration. */
export const connectButton = (h: H, model: Model, integration: IntegrationId): Html | undefined => {
	if (!Schema.is(ConnectProvider)(integration)) return undefined
	const entry = catalogEntry(integration)
	return button(
		h,
		{
			size: "sm",
			isLoading: model.connect.isStarting,
			// Linear's and Google's starts are admin-only on the server.
			isDisabled:
				(integration === "linear" || integration === "google-search-console") && !canManage(model),
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
		case "linear":
			return [linearCard(h, model)]
		case "github":
			return githubCard(h, model, timeZone)
		case "google-search-console":
			return [searchConsoleCard(h, model)]
		case "cloudflare":
			return [cloudflareCard(h, model, timeZone)]
		case "railway":
			return [railwayCard(h, model, timeZone)]
		case "vercel":
			return vercelCard(h, model, timeZone)
		case "supabase":
			return [supabaseCard(h, model, timeZone)]
		case "planetscale":
			return [planetscaleCard(h, model, timeZone)]
		case "gcp":
			return [gcpCard(h, model, timeZone, focusId)]
		case "aws":
			return [awsCard(h, model, timeZone, focusId)]
		case "prometheus":
		case "warpstream":
			return focusId === null
				? [
						scrapeIntro(h, integration),
						...scrapeTargetsSection(h, model, timeZone, null, integration),
					]
				: scrapeTargetsSection(h, model, timeZone, focusId, integration)
		default:
			return []
	}
}

const detailView = (h: H, model: Model, entry: CatalogEntry, timeZone: string): Html => {
	const integration = entry.id
	return dashboardPage(
		h,
		{
			filtersLabel: "Settings",
			filters: settingsNav(h, model),
			titleContent: integrationHeader(
				h,
				model,
				entry,
				{
					connect: connectButton(h, model, integration),
					actions:
						integration === "cloudflare"
							? cloudflareHeaderActions(h, model)
							: integration === "vercel"
								? vercelHeaderActions(h, model)
								: undefined,
					statusLine:
						integration === "gcp"
							? gcpHeaderStatus(h, model)
							: integration === "vercel"
								? vercelHeaderStatus(h, model, timeZone)
								: undefined,
				},
				timeZone,
			),
			width: "settings",
			gap: "md",
		},
		cardView(h, model, integration, timeZone),
	)
}

/** The settings rail with "Integrations" the active link, gated like `/settings`. */
const settingsNav = (h: HtmlBuilder<Message>, model: Model): Html =>
	navShell(h, visibleSections(settingsNavVisibility(model, isClerkAuthEnabled)), "integrations", (tab) =>
		Message.ClickedSettingsTab({ tab }),
	)

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const entry = entryOfSearch(model.search.integration)
	return entry === null
		? dashboardPage(
				h,
				{
					titleContent: hubTitle(h),
					filtersLabel: "Settings",
					filters: settingsNav(h, model),
					actions: integrationsSummary(h, model) ?? h.empty,
					width: "settings",
				},
				[integrationCatalog(h, model, selectIntegration)],
			)
		: detailView(h, model, entry, inputs.context.timeZone)
})
