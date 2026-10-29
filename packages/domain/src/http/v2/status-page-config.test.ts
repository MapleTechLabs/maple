import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { StatusPageComponentId } from "../../primitives"
import { DEFAULT_STATUS_PAGE_THEME } from "../../status-page"
import { diffStatusPageConfig, StatusPageConfig } from "./status-pages"

const API = StatusPageComponentId.make("11111111-1111-4111-8111-111111111111")
const WEB = StatusPageComponentId.make("22222222-2222-4222-8222-222222222222")
const DOCS = StatusPageComponentId.make("33333333-3333-4333-8333-333333333333")
const STRAY = StatusPageComponentId.make("44444444-4444-4444-8444-444444444444")

const current: StatusPageConfig = {
	name: "Acme",
	slug: "acme",
	description: null,
	website_url: null,
	logo_url: null,
	show_powered_by: true,
	auto_incidents: "off",
	theme: DEFAULT_STATUS_PAGE_THEME,
	components: [
		{
			id: API,
			name: "API",
			description: null,
			group: null,
			monitor_id: null,
			manual_status: null,
			show_uptime: true,
		},
		{
			id: WEB,
			name: "Web",
			description: null,
			group: null,
			monitor_id: null,
			manual_status: null,
			show_uptime: true,
		},
		{
			id: DOCS,
			name: "Docs",
			description: null,
			group: null,
			monitor_id: null,
			manual_status: null,
			show_uptime: true,
		},
	],
}

describe("diffStatusPageConfig", () => {
	it("reads omitted optional fields as their defaults, so a minimal copy changes nothing", () => {
		const minimal: StatusPageConfig = {
			name: "Acme",
			slug: "acme",
			components: [
				{ id: API, name: "API" },
				{ id: WEB, name: "Web" },
				{ id: DOCS, name: "Docs" },
			],
		}
		expect(diffStatusPageConfig(current, minimal)).toEqual({
			fields: [],
			created: [],
			updated: [],
			deleted: [],
			reordered: false,
			unknownIds: [],
			duplicateIds: [],
		})
	})

	it("lists changed fields, created, updated and deleted components and a new order", () => {
		const changes = diffStatusPageConfig(current, {
			...current,
			name: "Acme Inc",
			theme: { preset: "paper" },
			components: [
				{ id: DOCS, name: "Docs" },
				{ id: API, name: "API", manual_status: "degraded" },
				{ name: "Status" },
			],
		})
		expect(changes).toMatchObject({
			fields: ["name", "theme"],
			created: ["Status"],
			updated: ["API"],
			deleted: ["Web"],
			reordered: true,
		})
	})

	it("flags ids that are not on the page and ids listed twice", () => {
		const changes = diffStatusPageConfig(current, {
			...current,
			components: [
				{ id: API, name: "API" },
				{ id: API, name: "API again" },
				{ id: STRAY, name: "Stray" },
			],
		})
		expect(changes.unknownIds).toEqual([STRAY])
		expect(changes.duplicateIds).toEqual([API])
	})

	it("decodes public ids on the wire and refuses a component without a name", () => {
		const decode = Schema.decodeUnknownSync(StatusPageConfig)
		const encoded = Schema.encodeSync(StatusPageConfig)(current)
		expect(encoded.components[0]?.id).toMatch(/^stc_/)
		expect(decode(encoded)).toEqual(current)
		expect(() => decode({ name: "Acme", slug: "acme", components: [{ name: "" }] })).toThrow()
	})
})
