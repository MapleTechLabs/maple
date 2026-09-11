/**
 * What a hypothesis lane may reach for, and the seed catalogue it falls back to.
 *
 * This replaced `lens-prompt.ts`, and the two things that changed are worth
 * being explicit about, because both were failure modes rather than style.
 *
 * **The tool universe now contains the error tools.** Not one of the five old
 * per-lens allowlists included `error_detail`, `find_errors`,
 * `list_error_issues` or `list_error_issue_events`. For an *error* incident —
 * the highest-volume kind by a wide margin — that meant no dispatched agent
 * could read the exception type, the message, or the stack. They were reasoning
 * about an error they could not look at.
 *
 * **`config_flags` is gone.** Its own instruction told the model "Maple has no
 * configuration-change or feature-flag tool", which is an accurate description
 * of a lane that cannot answer its own question. It burned a pass per run to
 * report that it could not check. The planner's rule — never propose a
 * hypothesis without an evidence source — is the general form of deleting it,
 * and `normalizePlan` enforces that mechanically by dropping any hypothesis
 * whose tool list comes back empty.
 *
 */
import { PermissionRule, type PermissionRuleset } from "@maple/domain/permission"
import type { InvestigationHypothesis, SeedLensId } from "@maple/domain/http"

/**
 * The read-only investigation subset of the tool registry.
 *
 * Everything that mutates state is excluded, so "You have READ-ONLY tools" is
 * enforced here rather than merely asserted to the model. Session-replay tools
 * are excluded too — they are the largest outputs in the registry and an
 * investigation has never needed one to reach a cause.
 */
export const INVESTIGATION_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	"diagnose_service",
	"error_detail",
	"find_errors",
	"inspect_trace",
	"inspect_span",
	"search_traces",
	"find_slow_traces",
	"search_logs",
	"mine_log_patterns",
	"compare_periods",
	"service_map",
	"get_service_top_operations",
	"list_services",
	"explore_attributes",
	"list_metrics",
	"query_data",
	"get_incident_timeline",
	"list_error_issue_events",
	"list_source_repositories",
	"search_source_code",
	"read_source_file",
	"sandbox_grep",
	"sandbox_list_files",
	"sandbox_read_file",
	"sandbox_exec",
])

/**
 * Everything a hypothesis lane may EVER be granted.
 *
 * The planner *proposes* tool names and they are intersected with this — never
 * trusted as given. Deny-by-default here rather than an allowlist assembled from
 * the planner's output is what keeps a mutating tool added to the registry next
 * month from becoming reachable by a model naming it.
 */
export const HYPOTHESIS_TOOL_UNIVERSE: ReadonlySet<string> = new Set([
	...INVESTIGATION_READ_ONLY_TOOLS,
	"list_error_issues",
	"list_error_incidents",
])

/** Deny everything, then name what this lane may reach for. */
export const hypothesisRuleset = (toolNames: ReadonlySet<string>): PermissionRuleset => [
	new PermissionRule({ tool: "*", action: "deny" }),
	...[...toolNames].sort().map((tool) => new PermissionRule({ tool, action: "allow" })),
]

/**
 * Tool names intersected with the universe, in a stable order.
 *
 * Sorted so a lane's ruleset — and therefore its prompt — is identical across a
 * workflow replay that produced the same plan. An unsorted intersection would
 * reorder tool definitions between attempts and break the prompt cache for no
 * behavioural reason.
 */
export const permittedTools = (proposed: ReadonlyArray<string>): ReadonlySet<string> =>
	new Set([...new Set(proposed)].filter((name) => HYPOTHESIS_TOOL_UNIVERSE.has(name)).sort())

export interface SeedHypothesis {
	readonly id: SeedLensId
	readonly name: string
	readonly question: string
	readonly claimToTest: string
	readonly toolNames: ReadonlyArray<string>
}

export const SEED_HYPOTHESES: ReadonlyArray<SeedHypothesis> = [
	{
		id: "downstream_dependency",
		name: "Downstream dependency",
		question: "Is a callee actually degraded, or only being blamed?",
		claimToTest:
			"A service this one calls degraded first, and its latency or errors propagate up as the observed symptom.",
		toolNames: [
			"service_map",
			"get_service_top_operations",
			"find_slow_traces",
			"inspect_trace",
			"inspect_span",
			"diagnose_service",
			"error_detail",
			"find_errors",
			"query_data",
		],
	},
	{
		id: "deploy_correlation",
		name: "Deploy correlation",
		question: "What shipped before the window, and does the onset line up?",
		claimToTest:
			"A release landed shortly before the onset and introduced the failure — visible as a change in service.version or vcs.ref.head.revision across the window.",
		toolNames: [
			"explore_attributes",
			"get_incident_timeline",
			"query_data",
			"search_traces",
			"error_detail",
			"list_error_issue_events",
			"list_source_repositories",
			"search_source_code",
			"read_source_file",
			"sandbox_grep",
			"sandbox_read_file",
		],
	},
	{
		id: "resource_saturation",
		name: "Resource saturation",
		question: "Did a pool, queue, memory or connection limit hit a ceiling?",
		claimToTest:
			"A bounded resource reached its limit inside the window, and requests fail or stall waiting on it.",
		toolNames: [
			"list_metrics",
			"query_data",
			"search_logs",
			"mine_log_patterns",
			"diagnose_service",
			"error_detail",
			"find_errors",
		],
	},
	{
		id: "traffic_shape",
		name: "Traffic shape",
		question: "Did the load change — volume, mix, or who is calling what?",
		claimToTest:
			"Throughput or the mix of operations shifted against the baseline for this hour, and the symptom follows the shift rather than preceding it.",
		toolNames: [
			"compare_periods",
			"query_data",
			"get_service_top_operations",
			"search_traces",
			"find_errors",
		],
	},
]

/**
 * What a hypothesis gets when the planner named only tools that do not exist.
 *
 * Deliberately generic and deliberately small: five tools that between them can
 * open almost any proposition about an OTel incident — the incident itself, its
 * errors, its traces, its logs, and a way to aggregate. Not the whole universe,
 * because a lane handed twenty tools with no steer spends its budget browsing.
 *
 * This exists because the alternative was worse. Dropping such a hypothesis
 * meant that when *every* hypothesis had a bad tool list — one typo'd
 * vocabulary, applied uniformly, which is exactly how a model fails — the entire
 * plan was discarded and three standing category probes ran in its place. A
 * planner-authored proposition with a repaired tool list is a better use of a
 * lane than a catalogue entry nobody chose. The `toolNames` rule still binds the
 * planner; this only stops one formatting slip from costing the whole plan.
 */
export const RESCUE_TOOL_NAMES: ReadonlyArray<string> = [
	"error_detail",
	"find_errors",
	"search_traces",
	"search_logs",
	"query_data",
]

/**
 * The rescue set must survive its own intersection, or the repair it exists to
 * perform silently becomes a drop and the seed fallback comes back. Asserted at
 * module load rather than in a test, for the same reason
 * `_assertPlannerToolsAreReadOnly` below is: a rename in the universe above
 * should fail the import, not one assertion in one suite.
 */
if (RESCUE_TOOL_NAMES.some((name) => !HYPOTHESIS_TOOL_UNIVERSE.has(name))) {
	throw new Error("RESCUE_TOOL_NAMES contains a tool outside HYPOTHESIS_TOOL_UNIVERSE")
}

/** Seed tool lists by id, for repairing a planner hypothesis that named a seed framing. */
export const seedToolNames = (seedLensId: string | null): ReadonlyArray<string> | null =>
	SEED_HYPOTHESES.find((seed) => seed.id === seedLensId)?.toolNames ?? null

/**
 * Seed hypotheses as plan entries, for the fallback path.
 *
 * `rationale` says plainly that nothing about *this* incident selected them.
 * A planner-written rationale cites what the sweep saw; pretending these do
 * would make the fallback indistinguishable from a real plan on the boards, and
 * the whole point of recording a plan is that a reader can tell.
 */
export const seedHypotheses = (
	width: number,
): ReadonlyArray<
	Pick<
		InvestigationHypothesis,
		"id" | "name" | "question" | "claimToTest" | "rationale" | "toolNames" | "priority" | "seedLensId"
	>
> =>
	SEED_HYPOTHESES.slice(0, Math.max(1, width)).map((seed, index) => ({
		id: seed.id,
		name: seed.name,
		question: seed.question,
		claimToTest: seed.claimToTest,
		rationale:
			"Standing hypothesis from the seed catalogue — planning produced no incident-specific plan, so this was not selected on the evidence.",
		toolNames: [...seed.toolNames],
		priority: index + 1,
		seedLensId: seed.id,
	}))
