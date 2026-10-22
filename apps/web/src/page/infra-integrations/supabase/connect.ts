import type { Html, HtmlBuilder } from "foldkit/html"
import {
	type IntegrationBrand,
	integrationEmpty,
	integrationEmptyCard,
	integrationEmptyFeatures,
	integrationEmptyHint,
	integrationEmptyMedia,
} from "../kit/integration-empty"

// The Supabase on-ramp both the integration card and /infra/supabase show while nothing is connected.

export const SUPABASE_ACCENT = "#3FCF8E"
export const SUPABASE_BRAND: IntegrationBrand = { icon: "SupabaseIcon", accent: SUPABASE_ACCENT }

export const SUPABASE_CONNECT_HINT =
	"Connect an organization, then pick the projects to collect metrics from."
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

/** The feature row and the connect card; `action` is the card's button. */
export const supabaseOnRamp = <M>(h: HtmlBuilder<M>, hint: string, action: Html | null): Html =>
	integrationEmpty(h, [
		integrationEmptyFeatures(h, FEATURES),
		integrationEmptyCard(h, [
			integrationEmptyMedia(h, SUPABASE_BRAND),
			integrationEmptyHint(h, [hint]),
			...(action === null ? [] : [action]),
		]),
	])
