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
 * Denial is stronger than approval-gating and, wherever nobody can approve, it is the only thing
 * that works: a gated tool is still announced to the model with a real schema, so the run spends a
 * tool call discovering that nobody is there to approve it, and since 2026-09 a returned failure
 * counts toward `repeatedFailureLimit`. An unoffered tool cannot be called at all.
 *
 * Two runs reach it. An investigation's unattended pass borrows it for one turn through
 * {@link rulesetForTurn}; the chat-platform bot agent declares it as its own `permission`, because
 * every one of its turns is read-only.
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
 * The ruleset one *turn* runs under, which is not always its agent's.
 *
 * `unapprovable` means nobody could answer an approval card on this turn. Two turns qualify, and
 * both would otherwise be handed nineteen mutating schemas on every model call plus a wasted call
 * and a repeated-failure slot the moment the model tried one: an investigation's autonomous pass,
 * which has no reader at all, and any turn running as the chat-platform bot, whose reply lands in
 * a channel with no approval affordance and whose actor is org-level, so the gate has no one
 * person to address.
 *
 * The bot agent already declares `READ_ONLY_RULESET` as its own `permission`; passing the flag as
 * well is what makes the *actor* read-only wherever it turns up, including on a session whose tab
 * prefix is not `bot-`. An investigation's attended follow-up is the opposite case — a person
 * asking Maple to act — and that is exactly when the gate is the point.
 */
export const rulesetForTurn = (
	agent: { readonly permission: PermissionRuleset },
	unapprovable: boolean,
): PermissionRuleset => (unapprovable ? READ_ONLY_RULESET : agent.permission)
