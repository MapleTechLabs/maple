import type { McpToolRegistrar } from "./types"
import { Effect, Schema, Array as Arr, String as Str } from "effect"
import { DescribeDashboardSchemaOutput } from "@maple/domain/mcp-outputs"
import {
	DASHBOARD_SCHEMA_SECTIONS,
	renderDashboardSchemaIndex,
	renderDashboardSchemaSection,
} from "../lib/dashboard-schema-doc"
import { DASHBOARD_TEMPLATES } from "@maple/backend/dashboard-templates"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "describe_dashboard_schema"

/** Sections this tool serves: the widget-schema reference plus create_dashboard's template catalogue. */
const SECTIONS = [...DASHBOARD_SCHEMA_SECTIONS, "templates"] as const

/** create_dashboard's templates, from the same definitions the web template gallery lists. */
export const renderTemplatesSection = (): string =>
	[
		"# Dashboard templates",
		"",
		"Pass the id as create_dashboard `template`. `service`, `metric_name` and `metric_type` fill the parameters.",
		"",
		"| template | Charts | Required |",
		"|---|---|---|",
		...DASHBOARD_TEMPLATES.map((t) => {
			const required = t.parameters
				.filter((p) => p.required)
				.map((p) => (p.key === "service_name" ? "service" : p.key))
			return `| \`${t.id}\` | ${t.description} | ${required.join(", ") || "-"} |`
		}),
		"",
		"`custom` takes `dashboard_json` instead.",
	].join("\n")

const renderIndex = (): string =>
	`${renderDashboardSchemaIndex()}\n\nAlso \`section: "templates"\`: the create_dashboard templates and what each charts.`

/** The generated markdown opens with its own heading; the doc's title takes its place. */
const splitHeading = (markdown: string): { readonly title: string; readonly body: string } => {
	const [first, ...rest] = Str.split("\n")(markdown)
	return Str.startsWith("#")(first)
		? { title: Str.replace(/^#+\s*/, "")(first), body: Str.trim(Arr.join(rest, "\n")) }
		: { title: "Dashboard widget schema", body: markdown }
}

export function registerDescribeDashboardSchemaTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Describe Dashboard Schema",
		description:
			"What a dashboard widget can be: panel types, the four data-source kinds, the unit vocabulary, aggregations and group-by tokens, the display config, and (section templates) the create_dashboard templates. Generated from the live schema; read it before authoring or editing widgets rather than working from a remembered example.",
		parameters: Schema.Struct({
			section: P.optionalOneOf(SECTIONS, "Omit for the index plus the panel-type table."),
		}),
		output: DescribeDashboardSchemaOutput,
		hints: { readOnly: true },
		phrases: ["Reading the dashboard schema"],
		handler: Effect.fn("McpTool.describeDashboardSchema")(function* ({ section }) {
			if (section === undefined) return { markdown: renderIndex() }
			if (section === "templates") return { section, markdown: renderTemplatesSection() }
			return { section, markdown: renderDashboardSchemaSection(section) }
		}),
		render: (output) => {
			const { title, body } = splitHeading(output.markdown)
			return { title, blocks: [doc.text(body)] }
		},
	})
}
