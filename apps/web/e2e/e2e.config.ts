import { anthropic } from "@ai-sdk/anthropic"
import { web } from "@e2e-dev/web"
import type { E2EConfig } from "e2e"

// Runs against a deployed stack: a PR preview in CI, any signed-in-able URL locally.
// `agent.*` steps need ANTHROPIC_API_KEY; without it those tests skip themselves.
const config: E2EConfig = {
	projectId: "maple-web",
	targets: [
		{
			name: "web",
			engine: web(),
			app: {
				url: process.env.MAPLE_E2E_APP_URL ?? "http://localhost:3471",
				// Every PR preview is its own origin; one identity lets them share replay recordings.
				identity: "maple-web",
				environment: "staging",
			},
		},
	],
	timeout: 180_000,
	assertionTimeout: 15_000,
}

if (process.env.ANTHROPIC_API_KEY) {
	config.agents = { default: { model: anthropic("claude-sonnet-5-5") } }
}

export default config
