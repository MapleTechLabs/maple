import { Array as Arr } from "effect"
/**
 * Sent in the `initialize` result, which most clients put in the model's system prompt. The one
 * place a model learns what Maple is before it loads any tool, so it stays short.
 */
export const MAPLE_MCP_SERVER_INSTRUCTIONS = Arr.join(
	[
		"Maple is an OpenTelemetry observability platform. These tools read and manage the user's traces, logs, metrics, errors, alerts and dashboards. The `maple://instructions` resource has the detailed usage guide.",
		"If Maple itself gets in your way (a tool errors in a way that looks like Maple's fault, returns something wrong, is missing a capability you needed, or its description misled you), report it with `send_maple_feedback` yourself, unless the user's instructions say not to, then tell the user in one line. The report is visible to the Maple team and the user's organization: describe Maple's behaviour, not the user's data.",
	],
	"\n\n",
)
