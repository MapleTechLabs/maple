import type { McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { DescribeDashboardSchemaOutput } from "@maple/domain/mcp-outputs"
import {
	DASHBOARD_SCHEMA_SECTIONS,
	renderDashboardSchemaIndex,
	renderDashboardSchemaSection,
} from "../lib/dashboard-schema-doc"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "describe_dashboard_schema"

/** The generated markdown opens with its own heading; the doc's title takes its place. */
const splitHeading = (markdown: string): { readonly title: string; readonly body: string } => {
	const [first = "", ...rest] = markdown.split("\n")
	return first.startsWith("#")
		? { title: first.replace(/^#+\s*/, ""), body: rest.join("\n").trim() }
		: { title: "Dashboard widget schema", body: markdown }
}

export function registerDescribeDashboardSchemaTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		description:
			"Discover what a dashboard widget can be: every panel type, the four data-source kinds, the unit vocabulary, valid aggregations and group-by tokens, and the display config. Call it before authoring or editing widgets — the tables are generated from the live schema, so unlike a remembered example they cannot be out of date.",
		parameters: Schema.Struct({
			section: P.optionalOneOf(
				DASHBOARD_SCHEMA_SECTIONS,
				"Optional section. Omit for an index plus the panel-type table.",
			),
		}),
		output: DescribeDashboardSchemaOutput,
		hints: { readOnly: true },
		phrases: ["Reading the dashboard schema"],
		handler: Effect.fn("McpTool.describeDashboardSchema")(function* ({ section }) {
			return section === undefined
				? { markdown: renderDashboardSchemaIndex() }
				: { section, markdown: renderDashboardSchemaSection(section) }
		}),
		render: (output) => {
			const { title, body } = splitHeading(output.markdown)
			return { title, blocks: [doc.text(body)] }
		},
	})
}
