/** Small descriptor fixture; the API tests its full registry against the same policy. */
export const testTools = [
	"list_services",
	"find_errors",
	"search_traces",
	"query_data",
	"create_alert_rule",
	"update_dashboard_widget",
].map((name) => ({
	name,
	description: name,
	inputSchema: { type: "object", properties: {}, additionalProperties: true },
	mutating: name.startsWith("create_") || name.startsWith("update_"),
}))

import { layerLlm } from "../src/platform/Llm"
/** Scripted models never call providers, but ResolvedModel retains their requirements. */
export const testClients = layerLlm({})
