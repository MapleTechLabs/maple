import { OrgId } from "@maple/domain"
import { V2DashboardTemplate, V2DashboardTemplatePreview } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { FetchWidget } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

// A template's preview tiles read its variables at their defaults, never the literal `$project`.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }

const template = Schema.decodeUnknownSync(Schema.toType(V2DashboardTemplate))({
	id: "gcp",
	object: "dashboard_template",
	name: "Google Cloud",
	description: "GCP board.",
	category: "infrastructure",
	tags: [],
	requirements: [],
	requirement: null,
	requiredMetricPrefixes: [],
	parameters: [],
	preview: [],
})

const preview = Schema.decodeUnknownSync(Schema.toType(V2DashboardTemplatePreview))({
	object: "dashboard_template_preview",
	name: "Google Cloud",
	timeRange: { type: "relative", value: "6h" },
	widgets: [
		{
			id: "spans",
			visualization: "chart",
			dataSource: {
				kind: "query",
				resultShape: "timeseries",
				queries: [
					{
						id: "q",
						name: "Spans",
						dataSource: "traces",
						aggregation: "count",
						whereClause: 'resource.cloud.account.id = "$project"',
						addOns: { groupBy: false, having: false, orderBy: false, limit: false, legend: false },
						groupBy: [],
					},
				],
			},
			display: { title: "Spans in $project" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
	],
	variables: [{ name: "project", type: "textbox", defaultValue: "acme-prod" }],
})

const step = (model: Model, message: Message) => update(model, message, context)

describe("template preview variables", () => {
	test("preview tiles query with each variable's default", () => {
		const entered = init({ search: { template: "gcp" } }, context).model
		const listed = step(entered, Message.CompletedFetchTemplates({ key: entered.templates.key ?? "", result: Result.succeed([template]) })).model
		const clocked = step(listed, Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z") })).model
		const armed = step(clocked, Message.ElapsedPreviewDelay({ generation: clocked.previewGeneration })).model
		const shown = step(armed, Message.CompletedFetchPreview({ key: armed.preview.key ?? "", result: Result.succeed(preview) }))
		const sent = JSON.stringify((shown.commands ?? []).filter(({ name }) => name === FetchWidget.name).map(({ args }) => args))
		expect(sent).toContain("acme-prod")
		expect(sent).not.toContain("$project")
	})
})
