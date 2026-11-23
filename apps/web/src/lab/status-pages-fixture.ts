import { StatusPageId, UptimeMonitorId } from "@maple/domain"
import type { V2StatusPage } from "@maple/domain/http/v2"
import { DEFAULT_STATUS_PAGE_THEME, type StatusPagePublicSnapshot } from "@maple/domain/status-page"
import { Schema, Array as Arr } from "effect"
import { makeComponent, makeDays, makeSnapshot } from "@maple/status-page/fixtures"
import { type StatusPageSummary, summarizePage } from "../page/status-pages/shared/derive"
import { incident } from "../page/status-pages/shared/test-pages"

// `/lab/status-pages` fixture: a live page with upcoming maintenance, an internal one whose last
// publish failed, with a draft incident, and a draft page with no components yet.
// The live and internal pages have uploaded favicons.

export const LAB_ORG = "org_lab_status_pages"
/** `statusPageOrgKey(LAB_ORG)`, fixed here because the labs seed their models synchronously. */
export const LAB_ORG_KEY = "b00995ea1f46"

/** Uploaded images as the API stores them: base64 `data:` URLs. */
export const LAB_FAVICON =
	"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNyIgZmlsbD0iI2U4NTkwYyIvPjxwYXRoIGQ9Ik05IDI0IDE2IDhsNyAxNmgtNGwtMy03LTMgN3oiIGZpbGw9IiNmZmYiLz48L3N2Zz4="
const LAB_FAVICON_TOOLS =
	"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiMyYjhhM2UiLz48cmVjdCB4PSIxMCIgeT0iMTAiIHdpZHRoPSIxMiIgaGVpZ2h0PSIxMiIgcng9IjIiIGZpbGw9IiNmZmYiLz48L3N2Zz4="
export const LAB_LOGO =
	"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNjAgMzIiPjxyZWN0IHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgcng9IjciIGZpbGw9IiNlODU5MGMiLz48cGF0aCBkPSJNOSAyNCAxNiA4bDcgMTZoLTRsLTMtNy0zIDd6IiBmaWxsPSIjZmZmIi8+PHRleHQgeD0iNDIiIHk9IjIzIiBmb250LWZhbWlseT0ic3lzdGVtLXVpLHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMjAiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiMxYzE5MTciPkFjbWU8L3RleHQ+PC9zdmc+"
export const LAB_LOGO_DARK =
	"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNjAgMzIiPjxyZWN0IHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgcng9IjciIGZpbGw9IiNlODU5MGMiLz48cGF0aCBkPSJNOSAyNCAxNiA4bDcgMTZoLTRsLTMtNy0zIDd6IiBmaWxsPSIjMWMxOTE3Ii8+PHRleHQgeD0iNDIiIHk9IjIzIiBmb250LWZhbWlseT0ic3lzdGVtLXVpLHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMjAiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiNmYWZhZjkiPkFjbWU8L3RleHQ+PC9zdmc+"
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

/** Each monitored component's uptime monitor, so its row links to the monitor's checks. */
const monitorsOf = (snapshot: StatusPagePublicSnapshot) =>
	Arr.flatMap(snapshot.components, (component, index) =>
		component.monitored
			? [
					{
						id: component.id,
						monitor_id: Schema.decodeSync(UptimeMonitorId)(
							`0199a009-0000-7000-8000-00000000001${index}`,
						),
					},
				]
			: [],
	)

const labPage = (input: Omit<Parameters<typeof summarizePage>[0], "components">): StatusPageSummary =>
	summarizePage({ ...input, components: monitorsOf(input.snapshot) })

const hoursFromNow = (hours: number) => new Date(LAB_NOW_MS + hours * 60 * MINUTE).toISOString()

export const LAB_PAGES: ReadonlyArray<StatusPageSummary> = [
	labPage({
		page: page(1, { favicon_url: LAB_FAVICON }),
		snapshot: makeSnapshot({
			components: [
				makeComponent(0, {
					name: "API",
					group: "Platform",
					days: makeDays(LAB_NOW_MS, { 61: "degraded" }),
				}),
				makeComponent(1, { name: "Dashboard", group: "Platform", days: makeDays(LAB_NOW_MS) }),
				makeComponent(2, {
					name: "Ingest",
					group: "Data",
					days: makeDays(LAB_NOW_MS, { 84: "down" }),
				}),
				makeComponent(3, { name: "Docs", monitored: false, days: [] }),
			],
		}),
		incidents: [
			incident(1, {
				kind: "maintenance",
				status: "scheduled",
				title: "Database upgrade",
				impact: "none",
				scheduled_start: hoursFromNow(26),
				scheduled_end: hoursFromNow(28),
			}),
		],
	}),
	labPage({
		page: page(2, {
			name: "Internal tools",
			slug: "acme-internal",
			favicon_url: LAB_FAVICON_TOOLS,
			visibility: "internal",
			last_publish_error: "The custom domain did not verify",
		}),
		snapshot: makeSnapshot({
			components: [
				makeComponent(0, {
					name: "CI runners",
					status: "partial_outage",
					days: makeDays(LAB_NOW_MS, { 88: "degraded", 89: "down" }),
				}),
				makeComponent(1, { name: "Admin panel", showUptime: false, days: [] }),
			],
		}),
		incidents: [incident(2, { title: "CI jobs queue for minutes", published: false })],
	}),
	labPage({
		page: page(3, { name: "Partner API", slug: "partner-api", draft: true, published_at: null }),
		snapshot: makeSnapshot({ components: [] }),
		incidents: [],
	}),
]
