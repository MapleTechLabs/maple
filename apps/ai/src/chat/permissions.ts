/**
 * The rulesets Maple's chat agents run under.
 *
 * `MUTATING_TOOL_NAMES` stays exactly where it is and keeps its shape: it seeds `DEFAULT_RULESET`
 * here, and it remains the allowlist floor for `POST /internal/chat/apply`. That is the whole migration
 * story — the mirror in `apps/slack-agent/agent/lib/approval.ts` needs no change, and the
 * equivalence is pinned by a test in `apps/api/src/mcp/tools/mutating.test.ts` so day-one behaviour
 * cannot drift by accident.
 */
import { PermissionRule, type PermissionRuleset } from "@maple/domain/permission"
import { MUTATING_TOOL_NAMES } from "../mcp/tools/mutating"
import { mapleToolCatalog } from "../mcp/tools/registry"

/**
 * Today's behaviour, expressed as data: everything runs, mutations stop and ask.
 *
 * Sorted so the ruleset is stable across builds — it is a value that will end up in logs and,
 * eventually, in a settings UI diff.
 */
export const DEFAULT_RULESET: PermissionRuleset = [
	new PermissionRule({ tool: "*", action: "allow" }),
	...[...MUTATING_TOOL_NAMES].sort().map((tool) => new PermissionRule({ tool, action: "ask" })),
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
	...mapleToolCatalog
		.filter((definition) => !MUTATING_TOOL_NAMES.has(definition.name))
		.map((definition) => definition.name)
		.sort()
		.map((tool) => new PermissionRule({ tool, action: "allow" })),
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
	"pr_file_diff",
	"sandbox_grep",
	"sandbox_list_files",
	"sandbox_read_file",
	"sandbox_exec",
	"list_source_repositories",
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
]

export const PR_REVIEW_RULESET: PermissionRuleset = [
	new PermissionRule({ tool: "*", action: "deny" }),
	...[...PR_REVIEW_TOOLS].sort().map((tool) => new PermissionRule({ tool, action: "allow" })),
]
