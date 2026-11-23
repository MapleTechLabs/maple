import { describe, expect, it } from "vitest"
import { Array as Arr } from "effect"
import { fuzzyRecords, toRecords } from "../lib/docs-search"
import { SAMPLE_DOCS } from "./docs-search-sample"

// The palette's typo fallback over a slice of the real docs. Each row is the top three as the
// earlier search library ranked them, except where noted.
const search = fuzzyRecords(toRecords(SAMPLE_DOCS))
const top3 = (query: string) =>
	Arr.map(search(query, 10).slice(0, 3), ({ item }) => item.url.replace("/docs/", ""))

describe("docs fuzzy fallback", () => {
	it.each([
		// A dropped letter finds the page, then its sections; a page title outranks its sections.
		// "tracs" third was "The trace list", tied at one edit with "Initialize tracing".
		["tracs", ["explore/traces", "explore/traces#h2", "agent-tracing/llamaindex#h3"]],
		["sesion", ["agent-sessions/overview", "agent-sessions/overview#h1", "agent-sessions/overview#h0"]],
		["opentelemtry", ["concepts/otel-conventions", "agent-tracing/spring-ai#h1", "agent-tracing/eve"]],
		["alrt rules", ["alerting/alert-rules", "alerting/rule-evaluation", "alerting/alert-rules#h0"]],
		["dashbord", ["dashboards/embed-charts", "iac/pulumi#h3", "dashboards/embed-charts#h0"]],
		["webhoks", ["reference/webhooks", "reference/webhooks#h0", "reference/webhooks#h1"]],
		[
			"uptme",
			["alerting/uptime-monitoring", "alerting/uptime-monitoring#h0", "alerting/uptime-monitoring#h1"],
		],
		["Railwya", ["integrations/railway", "integrations/railway#h0", "integrations/railway#h1"]],
		// Was led by "Google Cloud manual setup", three edits away; "Quick setup" is one.
		[
			"quik setup",
			["agent-tracing/claude-agent-sdk#h0", "agent-tracing/eve#h0", "agent-tracing/haystack#h0"],
		],
		[
			"chekpoints",
			[
				"local-mode/checkpoints-and-archives#h0",
				"local-mode/checkpoints-and-archives",
				"local-mode/checkpoints-and-archives#h1",
			],
		],
		// Exact words: the page first when it carries the word, otherwise the sections in order.
		["pulumi", ["iac/pulumi", "iac/pulumi#h2", "iac/pulumi#h0"]],
		["retention", ["reference/retention", "reference/retention#h0", "reference/retention#h1"]],
		[
			"heartbeat",
			[
				"alerting/heartbeat-monitors",
				"alerting/heartbeat-monitors#h0",
				"alerting/heartbeat-monitors#h1",
			],
		],
		[
			"Install",
			[
				"guides/instrumentation-csharp#h1",
				"guides/instrumentation-kotlin#h1",
				"guides/instrumentation-nodejs#h1",
			],
		],
		[
			"verify",
			[
				"agent-tracing/cloudflare-ai-gateway#h3",
				"infrastructure/docker#h2",
				"integrations/gcp-manual-setup#h3",
			],
		],
		["sdk", ["sdks/effect-foldkit", "agent-tracing/openai-agents", "agent-tracing/provider-sdks"]],
		// Headings that start with the word now lead; "Which charts can be embedded" was first.
		["embed", ["dashboards/embed-charts#h0", "dashboards/embed-charts", "dashboards/embed-charts#h3"]],
	])("%s", (query, expected) => {
		expect(top3(query)).toEqual(expected)
	})

	it("finds every guide for a misspelt shared word", () => {
		expect(top3("instrumentaton")).toHaveLength(3)
		expect(top3("instrumentaton").every((url) => url.startsWith("guides/instrumentation-"))).toBe(true)
	})

	it("returns nothing for gibberish, for pages outside the index, and below three letters", () => {
		expect(search("zzqxvj")).toEqual([])
		expect(search("kubernets")).toEqual([])
		expect(search("ab")).toEqual([])
	})
})
