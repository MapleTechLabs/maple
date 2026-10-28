import {
	StatusPageComponentId,
	StatusPageId,
	StatusPageIncidentId,
	StatusPageIncidentUpdateId,
} from "@maple/domain"
import type { V2StatusPage, V2StatusPageComponent, V2StatusPageIncident } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { NOW } from "../shared/test-rows"

// Status pages as the v2 API decodes them, for the scene tests.

const iso = (msBefore: number) => new Date(NOW - msBefore).toISOString()
const MINUTE = 60_000

export const pageId = (n: number) =>
	Schema.decodeSync(StatusPageId)(`0199a010-0000-7000-8000-00000000000${n}`)
export const componentId = (n: number) =>
	Schema.decodeSync(StatusPageComponentId)(`0199a011-0000-7000-8000-00000000000${n}`)
export const incidentId = (n: number) =>
	Schema.decodeSync(StatusPageIncidentId)(`0199a012-0000-7000-8000-00000000000${n}`)
const updateId = (n: number) =>
	Schema.decodeSync(StatusPageIncidentUpdateId)(`0199a013-0000-7000-8000-00000000000${n}`)

export const statusPage = (fields: Partial<V2StatusPage> = {}): V2StatusPage => ({
	id: pageId(1),
	object: "status_page",
	name: "Acme Status",
	slug: "acme-status",
	description: null,
	website_url: null,
	logo_url: null,
	brand_color: null,
	show_powered_by: true,
	auto_incidents: "draft",
	break_glass_token_suffix: null,
	revision: 3,
	published_revision: 3,
	published_at: iso(5 * MINUTE),
	last_publish_error: null,
	created_at: iso(60 * MINUTE),
	updated_at: iso(5 * MINUTE),
	...fields,
})

export const component = (n: number, fields: Partial<V2StatusPageComponent> = {}): V2StatusPageComponent => ({
	id: componentId(n),
	object: "status_page_component",
	page_id: pageId(1),
	name: `Component ${n}`,
	description: null,
	group: null,
	position: n - 1,
	monitor_id: null,
	manual_status: null,
	show_uptime: true,
	created_at: iso(60 * MINUTE),
	updated_at: iso(60 * MINUTE),
	...fields,
})

export const incident = (n: number, fields: Partial<V2StatusPageIncident> = {}): V2StatusPageIncident => ({
	id: incidentId(n),
	object: "status_page_incident",
	page_id: pageId(1),
	kind: "incident",
	title: `Incident ${n}`,
	impact: "major",
	status: "investigating",
	published: true,
	scheduled_start: null,
	scheduled_end: null,
	started_at: iso(10 * MINUTE),
	resolved_at: null,
	component_ids: [componentId(1)],
	updates: [
		{
			id: updateId(n),
			status: "investigating",
			body: "We are looking into elevated error rates.",
			source: "dashboard",
			created_at: iso(10 * MINUTE),
		},
	],
	created_at: iso(10 * MINUTE),
	updated_at: iso(10 * MINUTE),
	...fields,
})
