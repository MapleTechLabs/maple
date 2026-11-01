import { StatusPageId } from "@maple/domain"
import type { V2StatusPage } from "@maple/domain/http/v2"
import { DEFAULT_STATUS_PAGE_THEME } from "@maple/domain/status-page"
import { Schema } from "effect"
import type { StatusPageSummary } from "../page/status-pages/shared/derive"

// `/lab/status-pages` fixture: one live page and one whose last publish failed.

export const LAB_ORG = "org_lab_status_pages"
export const LAB_NOW_MS = Date.UTC(2026, 9, 1, 12, 0)

const MINUTE = 60_000
const iso = (msBefore: number) => new Date(LAB_NOW_MS - msBefore).toISOString()

const page = (n: number, fields: Partial<V2StatusPage>): V2StatusPage => ({
	id: Schema.decodeSync(StatusPageId)(`0199a010-0000-7000-8000-00000000000${n}`),
	object: "status_page",
	name: "Acme Status",
	slug: "acme-status",
	description: null,
	website_url: null,
	logo_url: null,
	privacy_url: null,
	terms_url: null,
	theme: DEFAULT_STATUS_PAGE_THEME,
	show_powered_by: true,
	auto_incidents: "draft",
	draft: false,
	break_glass_token_suffix: null,
	revision: 3,
	published_revision: 3,
	published_at: iso(5 * MINUTE),
	last_publish_error: null,
	created_at: iso(60 * MINUTE),
	updated_at: iso(5 * MINUTE),
	...fields,
})

export const LAB_PAGES: ReadonlyArray<StatusPageSummary> = [
	{ page: page(1, {}), overall: "operational", componentCount: 4, openIncidents: 0 },
	{
		page: page(2, {
			name: "Internal tools",
			slug: "acme-internal",
			last_publish_error: "The custom domain did not verify",
		}),
		overall: "partial_outage",
		componentCount: 2,
		openIncidents: 1,
	},
]
