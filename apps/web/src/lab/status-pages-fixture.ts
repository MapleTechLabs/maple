import { StatusPageId } from "@maple/domain"
import type { V2StatusPage } from "@maple/domain/http/v2"
import { DEFAULT_STATUS_PAGE_THEME } from "@maple/domain/status-page"
import { Schema } from "effect"
import { makeComponent, makeDays, makeSnapshot } from "@maple/status-page/fixtures"
import { type StatusPageSummary, summarizePage } from "../page/status-pages/shared/derive"
import { incident } from "../page/status-pages/shared/test-pages"

// `/lab/status-pages` fixture: a live page with upcoming maintenance, an internal one whose last
// publish failed, with a draft incident, and a draft page with no components yet.

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

const hoursFromNow = (hours: number) => new Date(LAB_NOW_MS + hours * 60 * MINUTE).toISOString()

export const LAB_PAGES: ReadonlyArray<StatusPageSummary> = [
	summarizePage({
		page: page(1, {}),
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
	summarizePage({
		page: page(2, {
			name: "Internal tools",
			slug: "acme-internal",
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
	summarizePage({
		page: page(3, { name: "Partner API", slug: "partner-api", draft: true, published_at: null }),
		snapshot: makeSnapshot({ components: [] }),
		incidents: [],
	}),
]
