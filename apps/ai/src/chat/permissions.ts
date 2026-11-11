/** The rulesets Maple's chat agents run under. */
import { PermissionRule, type PermissionRuleset } from "@maple/domain/permission"
import { mapleToolCatalog } from "../mcp/tools/registry"
import { Array as Arr } from "effect"

/**
 * Every tool that changes org data (`hints.readOnly: false`). The chat gates them behind approval,
 * and they are the only tools an approval may apply (`ChatSession.settleProposal`).
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set(
	Arr.map(
		Arr.filter(mapleToolCatalog, (definition) => !definition.hints.readOnly),
		(definition) => definition.name,
	),
)

/**
 * Today's behaviour, expressed as data: everything runs, mutations stop and ask.
 *
 * Sorted so the ruleset is stable across builds — it is a value that will end up in logs and,
 * eventually, in a settings UI diff.
 */
export const DEFAULT_RULESET: PermissionRuleset = [
	new PermissionRule({ tool: "*", action: "allow" }),
	...Arr.map([...MUTATING_TOOL_NAMES].sort(), (tool) => new PermissionRule({ tool, action: "ask" })),
]

/**
 * Read-only: deny everything, then name the tools that are allowed.
 *
 * Deliberately an allowlist of *concrete registered names* rather than `deny "*"` plus `allow
 * "get_*"` globs. A mutating tool added next month is denied by default under this ruleset instead
 * of slipping through whatever glob happened to match its name.
 *
 * Denial is stronger than approval-gating and, for an unattended run, it is the only thing that
 * works: a gated tool is still announced to the model with a real schema, so an autonomous pass
 * spends a tool call discovering that nobody is there to approve it, and since 2026-09 a returned
 * failure counts toward `repeatedFailureLimit`. An unoffered tool cannot be called at all.
 */
export const READ_ONLY_RULESET: PermissionRuleset = [
	new PermissionRule({ tool: "*", action: "deny" }),
	...Arr.map(
		Arr.map(
			Arr.filter(mapleToolCatalog, (definition) => !MUTATING_TOOL_NAMES.has(definition.name)),
			(definition) => definition.name,
		).sort(),
		(tool) => new PermissionRule({ tool, action: "allow" }),
	),
]

/**
 * What the pull request reviewer may call, by name.
 *
 * The diff tools, the sandbox and source tools for context, and the read-only telemetry tools the
 * rubric needs: whether the touched service reports at all, which operations it already has spans
 * for, and whether an attribute key the diff introduces exists in the org's data under another
 * spelling. Nothing that writes, and nothing that reads alerts, dashboards or issues: a review has
 * no use for them and every unused schema is prompt the model pays for on each call.
 */
export const PR_REVIEW_TOOLS: ReadonlyArray<string> = [
	"pr_changed_files",
	"pr_context",
	"pr_file_diff",
	"sandbox_grep",
	"sandbox_list_files",
	"sandbox_read_file",
	"sandbox_exec",
	"search_source_code",
	"read_source_file",
	"list_services",
	"get_service_top_operations",
	"explore_attributes",
	"search_traces",
	"service_map",
	"list_metrics",
	"audit_setup",
	"get_instrumentation_recommendations",
	// Production facts the kickoff states: traffic per route, deploys, and the errors in changed files.
	"route_usage",
	"service_deployments",
	"find_errors",
	"error_detail",
]

/**
 * The reviewer's tools and nothing else. A reply to a review thread runs under it too: it reads what
 * a review reads, and its only writes are its own completion tools.
 */
export const PR_REVIEW_RULESET: PermissionRuleset = [
	new PermissionRule({ tool: "*", action: "deny" }),
	...Arr.map([...PR_REVIEW_TOOLS].sort(), (tool) => new PermissionRule({ tool, action: "allow" })),
]

/** A reply reads what a review reads; its only writes are its own completion tools. */
export const PR_REPLY_RULESET: PermissionRuleset = PR_REVIEW_RULESET
