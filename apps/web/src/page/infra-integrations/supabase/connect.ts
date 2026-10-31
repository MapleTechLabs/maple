import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import {
	type IntegrationBrand,
	integrationConnectCta,
	integrationEmpty,
	integrationEmptyCard,
	integrationEmptyFeatures,
	integrationEmptyHint,
	integrationEmptyMedia,
} from "../kit/integration-empty"

// The Supabase on-ramp /infra/supabase shows while nothing is connected.

export const SUPABASE_ACCENT = "#3FCF8E"
export const SUPABASE_BRAND: IntegrationBrand = { icon: "SupabaseIcon", accent: SUPABASE_ACCENT }

export const SUPABASE_NOT_CONFIGURED = "Supabase isn't configured on this deployment."

const FEATURES = [
	{
		label: "Projects",
		title: "Projects in your organization",
		description: "Maple lists the projects in the connected organization and keeps the list current.",
	},
	{
		label: "Resources",
		title: "CPU, memory and disk",
		description: "Scraped every minute from each project's metrics endpoint. You pick which projects.",
	},
	{
		label: "Postgres",
		title: "Connections and transactions",
		description: "Backends, pooler clients, commits, rollbacks, cache hit ratio and database size.",
	},
] as const

/** The feature row and one way into the connect flow; a deployment without the OAuth app says so. */
export const supabaseConnectCta = <M>(h: HtmlBuilder<M>, isConfigured: boolean): Html =>
	isConfigured
		? integrationConnectCta(h, {
				brand: SUPABASE_BRAND,
				features: FEATURES,
				hint: "Connect an organization, then pick the projects to collect metrics and logs from.",
				label: "Connect Supabase",
				href: hrefOf(AppRoute.SourcesNew({ search: { integration: "supabase" } })),
			})
		: integrationEmpty(h, [
				integrationEmptyFeatures(h, FEATURES),
				integrationEmptyCard(h, [
					integrationEmptyMedia(h, SUPABASE_BRAND),
					integrationEmptyHint(h, [SUPABASE_NOT_CONFIGURED]),
				]),
			])
