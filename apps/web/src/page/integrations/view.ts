import { Schema } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { PageViewInputs } from "../contract"
import { dashboardPage } from "../kit/dashboard-page"
import { button } from "@maple/views/ui/button"
import { type CatalogEntry, catalogEntry, entryOfSearch, type IntegrationId } from "./catalog"
import { ConnectProvider } from "./connect"
import { Message } from "./message"
import type { Model } from "./model"
import { gatedControl } from "../kit/session-grants"
import { navShell } from "../kit/nav-shell"
import { isClerkAuthEnabled } from "../../platform/auth-mode"
import { visibleSections } from "../settings/nav"
import { settingsNavVisibility } from "./derive"
import { entryGlyph } from "./view-entry"
import { integrationHeader } from "./view-header"
import { hubTitle, integrationCatalog, integrationsSummary } from "./view-hub"
import { providerModuleOf } from "./provider-modules"

type H = HtmlBuilder<Message>

const selectIntegration = (id: IntegrationId) => Message.ClickedIntegration({ integration: id })

/** The header's Connect button for an OAuth integration. */
export const connectButton = (h: H, model: Model, integration: IntegrationId): Html | undefined => {
	if (!Schema.is(ConnectProvider)(integration)) return undefined
	const entry = catalogEntry(integration)
	const control = (isDisabled: boolean): Html =>
		button(
			h,
			{
				size: "sm",
				isLoading: model.connect.isStarting,
				isDisabled,
				attributes: [h.OnClick(Message.ClickedConnect())],
			},
			[entryGlyph(h, entry, undefined), "Connect ", entry.name],
		)
	// Linear's and Google's starts are gated on the server.
	return integration === "linear" || integration === "google-search-console"
		? gatedControl(h, model, "integrations:manage", control)
		: control(false)
}

/** The integration's own card under the header. */
export const cardView = (
	h: H,
	model: Model,
	integration: IntegrationId,
	timeZone: string,
	focusId: string | null = null,
): ReadonlyArray<Html> => {
	const provider = providerModuleOf(integration)
	return provider === undefined ? [] : provider.card(h, model, timeZone, focusId, integration)
}

const detailView = (h: H, model: Model, entry: CatalogEntry, timeZone: string): Html => {
	const integration = entry.id
	const provider = providerModuleOf(integration)
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
					actions: provider?.headerActions?.(h, model) ?? undefined,
					statusLine: provider?.headerStatus?.(h, model, timeZone) ?? undefined,
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
