import { useMemo, useState } from "react"
import { PageLayout } from "@maple/ui/components/ui/page-layout"

import {
	agentSessionsSort,
	agentSessionsSortPatch,
	type AgentSessionsSearchState,
} from "@/components/agent-sessions/agent-sessions-filter-inputs"
import { AgentSessionsList, type AgentSessionRow } from "@/components/agent-sessions/agent-sessions-list"

/**
 * `/agent-sessions` without a warehouse behind it.
 *
 * The list is the real one — the route mounts this same component — over rows
 * chosen for the shapes that break its columns: a named agent beside an
 * unidentified vendor, a session with no agent name at all, a session that is
 * one trace, a duration that runs to minutes next to one that runs to
 * milliseconds, a session that reported a total but no buckets, one that
 * reported no usage at all, and both kinds of failure.
 *
 * `ai_trace_index` does not exist in the local Tinybird container, so the live
 * page renders empty here; this is where a row change gets looked at.
 */

/** Widths worth checking, because the columns are container queries against
 *  `@container/page`, which `PageLayout.Content` declares: Model leaves below
 *  1270px, Services below 1110, Tokens below 940, the call counts below
 *  810/690, Cost and Duration below 580/500, and below 400 the time moves
 *  into the Session cell. */
const WIDTHS = [
	{ label: "Full", value: null },
	{ label: "1300px", value: 1300 },
	{ label: "1000px", value: 1000 },
	{ label: "700px", value: 700 },
	{ label: "380px", value: 380 },
] as const

const BASE: AgentSessionRow = {
	sessionId: "wrun_01M0CSAEW96BH2W9185XZPRPKH",
	vendorId: "claude_agent_sdk",
	traceCount: 3,
	spanCount: 142,
	errorSpanCount: 0,
	toolErrorCount: 0,
	turnErrorCount: 0,
	serviceNames: ["maple-slack-agent"],
	models: ["claude-sonnet-5"],
	agentNames: ["slack-triage"],
	firstAgentName: "slack-triage",
	llmCalls: 24,
	toolCalls: 61,
	totalTokens: 1_284_000,
	inputTokens: 184_000,
	cacheReadTokens: 940_000,
	cacheWriteTokens: 96_000,
	outputTokens: 42_000,
	reasoningTokens: 22_000,
	cost: 1.83,
	startTime: "",
	endTime: "",
	durationMs: 184_000,
}

function buildRows(nowMs: number): ReadonlyArray<AgentSessionRow> {
	const at = (minutesAgo: number, durationMs: number) => {
		const start = nowMs - minutesAgo * 60_000
		const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "")
		return {
			startTime: iso(start),
			endTime: iso(start + durationMs),
			durationMs,
		}
	}
	return [
		{ ...BASE, ...at(4, 184_000) },
		{
			...BASE,
			...at(9, 1_240),
			sessionId: "wrun_01M0CSAEW96BH2W9185XZPRQ44",
			vendorId: "openai_agents_sdk",
			// The set is unordered; the row is named by the earliest span's agent.
			agentNames: ["web-fetcher", "deep-research"],
			firstAgentName: "deep-research",
			serviceNames: ["research-worker", "api"],
			models: ["openai/gpt-5.6", "openai/gpt-5.5"],
			llmCalls: 3,
			toolCalls: 1,
			spanCount: 11,
			traceCount: 1,
			totalTokens: 41_200,
			inputTokens: 28_000,
			cacheReadTokens: 0,
			cacheWriteTokens: 4_200,
			outputTokens: 6_000,
			reasoningTokens: 3_000,
			cost: 0.09,
		},
		{
			...BASE,
			...at(26, 3_920_000),
			sessionId: "wrun_01M0CSAEW96BH2W9185XZPRZZ9",
			vendorId: "langchain",
			agentNames: [],
			firstAgentName: "",
			serviceNames: ["ingest-classifier"],
			models: ["bedrock/us.anthropic.claude-opus-5"],
			llmCalls: 412,
			toolCalls: 1_204,
			spanCount: 4_318,
			traceCount: 61,
			errorSpanCount: 26,
			toolErrorCount: 24,
			turnErrorCount: 1,
			totalTokens: 22_400_000,
			inputTokens: 3_100_000,
			cacheReadTokens: 17_800_000,
			cacheWriteTokens: 810_000,
			outputTokens: 480_000,
			reasoningTokens: 210_000,
			cost: 41.6,
		},
		{
			...BASE,
			...at(51, 12_400),
			// An unidentified vendor stamps no session key, so the session is the trace.
			sessionId: "trace:4bf92f3577b34da6a3ce929d0e0e4736",
			vendorId: "unknown:my-inhouse-agent",
			agentNames: ["nightly-reconcile"],
			firstAgentName: "nightly-reconcile",
			serviceNames: ["billing"],
			models: ["gemini-3-pro"],
			llmCalls: 7,
			toolCalls: 0,
			spanCount: 24,
			traceCount: 1,
			errorSpanCount: 12,
			toolErrorCount: 0,
			turnErrorCount: 12,
			totalTokens: 812_000,
			inputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			outputTokens: 0,
			reasoningTokens: 0,
			cost: 0,
		},
		{
			...BASE,
			...at(118, 640),
			sessionId: "wrun_01M0CSAEW96BH2W9185XZPRCD2",
			vendorId: "vercel_ai_sdk",
			agentNames: ["support-autoresponder-with-a-very-long-name"],
			firstAgentName: "support-autoresponder-with-a-very-long-name",
			serviceNames: ["support-web", "support-api", "kb-search"],
			models: ["claude-haiku-4-5"],
			llmCalls: 1,
			toolCalls: 0,
			spanCount: 4,
			traceCount: 1,
			totalTokens: 0,
			inputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			outputTokens: 0,
			reasoningTokens: 0,
			cost: 0,
		},
		{
			...BASE,
			...at(240, 74_000),
			sessionId: "wrun_01M0CSAEW96BH2W9185XZPREF3",
			vendorId: "crewai",
			agentNames: ["coder", "planner", "reviewer"],
			firstAgentName: "planner",
			serviceNames: ["crew-runner"],
			models: ["claude-opus-5"],
			llmCalls: 38,
			toolCalls: 9,
			spanCount: 210,
			traceCount: 2,
			totalTokens: 640_000,
			inputTokens: 210_000,
			cacheReadTokens: 300_000,
			cacheWriteTokens: 40_000,
			outputTokens: 60_000,
			reasoningTokens: 30_000,
			cost: 7.42,
		},
	]
}

export function AgentSessionsListLab() {
	// One timestamp for the life of the mount: "3m ago" that ticks while you are
	// looking at a spacing change is noise.
	const [nowMs] = useState(() => Date.now())
	const rows = useMemo(() => buildRows(nowMs), [nowMs])
	const [width, setWidth] = useState<number | null>(null)
	// No server to re-rank the rows: the headers only mark the order they would ask for.
	const [sortSearch, setSortSearch] = useState<Pick<AgentSessionsSearchState, "sortBy" | "sortDir">>({})
	const { sortBy, sortDir } = agentSessionsSort(sortSearch)

	return (
		<div className="flex h-svh flex-col gap-4 p-6">
			<div className="flex items-center gap-2">
				{WIDTHS.map((option) => (
					<button
						key={option.label}
						type="button"
						onClick={() => setWidth(option.value)}
						className={
							width === option.value
								? "rounded border border-border bg-accent px-2 py-1 text-xs"
								: "rounded border border-border px-2 py-1 text-xs text-muted-foreground"
						}
					>
						{option.label}
					</button>
				))}
			</div>
			{/* The route's own layout primitives: the list virtualizes against the
			    page's scroll area, and without one it renders no rows at all. */}
			<div className="flex min-h-0 flex-1 flex-col" style={width === null ? undefined : { width }}>
				<PageLayout.Root>
					<PageLayout.Content>
						<PageLayout.ScrollArea>
							<AgentSessionsList
								sessions={rows}
								sortBy={sortBy}
								sortDir={sortDir}
								onSortChange={(key) => setSortSearch((prev) => agentSessionsSortPatch(prev, key))}
							/>
						</PageLayout.ScrollArea>
					</PageLayout.Content>
				</PageLayout.Root>
			</div>
		</div>
	)
}
