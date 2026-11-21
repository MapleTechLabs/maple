import { Array as Arr } from "effect"

const WHAT_MAPLE_IS =
	"Maple is an OpenTelemetry observability platform. These tools read and manage the user's traces, logs, metrics, errors, alerts and dashboards. The `maple://instructions` resource has the detailed usage guide."

const DATA_SOURCES =
	"This org can connect external databases and APIs; find them and what they hold with `list_data_sources` and query them with `query_data_source`. The `maple://data-sources` resource lists them."

const FEEDBACK =
	"If Maple itself gets in your way (a tool errors in a way that looks like Maple's fault, returns something wrong, is missing a capability you needed, or its description misled you), report it with `send_maple_feedback` yourself, unless the user's instructions say not to, then tell the user in one line. The report is visible to the Maple team and the user's organization: describe Maple's behaviour, not the user's data."

/**
 * Sent in the `initialize` result, which most clients put in the model's system prompt. The one
 * place a model learns what Maple is before it loads any tool, so it stays short, and names data
 * sources only to an org that has them: a tool named here is a tool a model calls.
 */
export const mcpServerInstructions = (org: { readonly dataSources: boolean }): string =>
	Arr.join(org.dataSources ? [WHAT_MAPLE_IS, DATA_SOURCES, FEEDBACK] : [WHAT_MAPLE_IS, FEEDBACK], "\n\n")

/** What a caller with no known org reads. */
export const MAPLE_MCP_SERVER_INSTRUCTIONS = mcpServerInstructions({ dataSources: false })
