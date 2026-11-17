import { StatusPageId } from "@maple/domain"
import type { V2StatusPage } from "@maple/domain/http/v2"
import { DEFAULT_STATUS_PAGE_THEME } from "@maple/domain/status-page"
import { Schema } from "effect"
import type { StatusPageSummary } from "../page/status-pages/shared/derive"

// `/lab/status-pages` fixture: a live page, one whose last publish failed, a draft and an internal page.
// The first two have uploaded favicons; the others show the list without one.

export const LAB_ORG = "org_lab_status_pages"

/** Uploaded images as the API stores them: base64 `data:` URLs. */
export const LAB_FAVICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNyIgZmlsbD0iI2U4NTkwYyIvPjxwYXRoIGQ9Ik05IDI0IDE2IDhsNyAxNmgtNGwtMy03LTMgN3oiIGZpbGw9IiNmZmYiLz48L3N2Zz4="
const LAB_FAVICON_TOOLS = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiMyYjhhM2UiLz48cmVjdCB4PSIxMCIgeT0iMTAiIHdpZHRoPSIxMiIgaGVpZ2h0PSIxMiIgcng9IjIiIGZpbGw9IiNmZmYiLz48L3N2Zz4="
export const LAB_LOGO = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNjAgMzIiPjxyZWN0IHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgcng9IjciIGZpbGw9IiNlODU5MGMiLz48cGF0aCBkPSJNOSAyNCAxNiA4bDcgMTZoLTRsLTMtNy0zIDd6IiBmaWxsPSIjZmZmIi8+PHRleHQgeD0iNDIiIHk9IjIzIiBmb250LWZhbWlseT0ic3lzdGVtLXVpLHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMjAiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiMxYzE5MTciPkFjbWU8L3RleHQ+PC9zdmc+"
export const LAB_LOGO_DARK = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNjAgMzIiPjxyZWN0IHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgcng9IjciIGZpbGw9IiNlODU5MGMiLz48cGF0aCBkPSJNOSAyNCAxNiA4bDcgMTZoLTRsLTMtNy0zIDd6IiBmaWxsPSIjMWMxOTE3Ii8+PHRleHQgeD0iNDIiIHk9IjIzIiBmb250LWZhbWlseT0ic3lzdGVtLXVpLHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMjAiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiNmYWZhZjkiPkFjbWU8L3RleHQ+PC9zdmc+"
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
	logo_dark_url: null,
	favicon_url: null,
	support_url: null,
	privacy_url: null,
	terms_url: null,
	theme: DEFAULT_STATUS_PAGE_THEME,
	show_powered_by: true,
	auto_incidents: "draft",
	visibility: "public",
	has_password: false,
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
	{ page: page(1, { favicon_url: LAB_FAVICON }), overall: "operational", componentCount: 4, openIncidents: 0 },
	{
		page: page(2, {
			name: "Internal tools",
			slug: "acme-internal",
			favicon_url: LAB_FAVICON_TOOLS,
			last_publish_error: "The custom domain did not verify",
		}),
		overall: "partial_outage",
		componentCount: 2,
		openIncidents: 1,
	},
	{
		page: page(3, { name: "Partner API", slug: "acme-partners", draft: true, published_at: null }),
		overall: "operational",
		componentCount: 1,
		openIncidents: 0,
	},
	{
		page: page(4, { name: "Ops board", slug: "acme-ops", visibility: "internal" }),
		overall: "degraded",
		componentCount: 3,
		openIncidents: 0,
	},
]
