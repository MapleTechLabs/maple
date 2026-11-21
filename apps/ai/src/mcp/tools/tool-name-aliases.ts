import { Array as Arr, Predicate, Record as Rec } from "effect"

/** What a retired name means now: a registered tool, and the arguments the old name stood for. */
export interface ToolNameAlias {
	readonly tool: string
	readonly args?: Readonly<Record<string, string>>
	/** Arguments the old name took under a name its replacement gives another meaning. */
	readonly renamed?: Readonly<Record<string, string>>
}

const action = (tool: string, name: string, renamed?: ToolNameAlias["renamed"]): ToolNameAlias => ({
	tool,
	args: { action: name },
	...(renamed === undefined ? undefined : { renamed }),
})

/** An ingest rule's drop or redact spec was `action`, which a family reads as what to do. */
const RULE_ACTION = { action: "rule_action" }

/**
 * Retired tool names, mapped to the tool that replaced them. Accepted on every surface and never
 * listed, so a client holding an old tool list keeps working. Its own module: the transport reads it
 * without loading the registry.
 */
export const TOOL_NAME_ALIASES = {
	list_sources: { tool: "list_ingest_sources" },
	search_data_sources: { tool: "list_data_sources" },
	describe_data_source: { tool: "list_data_sources" },
	create_alert_silence: action("manage_alert_silence", "create"),
	end_alert_silence: action("manage_alert_silence", "end"),
	create_escalation_chain: action("manage_escalation_chain", "create"),
	update_escalation_chain: action("manage_escalation_chain", "update"),
	delete_escalation_chain: action("manage_escalation_chain", "delete"),
	create_ingest_rule: action("manage_ingest_rule", "create", RULE_ACTION),
	update_ingest_rule: action("manage_ingest_rule", "update", RULE_ACTION),
	delete_ingest_rule: action("manage_ingest_rule", "delete"),
	create_maintenance_window: action("manage_maintenance_window", "create"),
	delete_maintenance_window: action("manage_maintenance_window", "delete"),
	create_oncall_schedule: action("manage_oncall_schedule", "create"),
	update_oncall_schedule: action("manage_oncall_schedule", "update"),
	delete_oncall_schedule: action("manage_oncall_schedule", "delete"),
	create_oncall_override: action("manage_oncall_schedule", "add_override"),
	delete_oncall_override: action("manage_oncall_schedule", "remove_override"),
	create_scrape_target: action("manage_scrape_target", "create"),
	update_scrape_target: action("manage_scrape_target", "update"),
	delete_scrape_target: action("manage_scrape_target", "delete"),
	create_slo: action("manage_slo", "create"),
	update_slo: action("manage_slo", "update"),
	delete_slo: action("manage_slo", "delete"),
	create_status_page: action("manage_status_page", "create"),
	apply_status_page_config: action("manage_status_page", "apply_config"),
	publish_status_page: action("manage_status_page", "publish"),
	set_status_page_domain: action("manage_status_page", "set_domain"),
	post_status_page_update: action("manage_status_page", "post_update"),
	create_uptime_monitor: action("manage_uptime_monitor", "create"),
	update_uptime_monitor: action("manage_uptime_monitor", "update"),
	delete_uptime_monitor: action("manage_uptime_monitor", "delete"),
} as const satisfies Readonly<Record<string, ToolNameAlias>>

const ALIASES: ReadonlyMap<string, ToolNameAlias> = new Map(Rec.toEntries(TOOL_NAME_ALIASES))

/** The registered name a call means. */
export const canonicalToolName = (name: string): string => ALIASES.get(name)?.tool ?? name

/** The call a name and its arguments mean: a retired name's own arguments are added, and win. */
export const canonicalToolCall = (
	name: string,
	input: unknown,
): { readonly name: string; readonly input: unknown } => {
	const alias = ALIASES.get(name)
	if (alias === undefined) return { name, input }
	if (alias.args === undefined) return { name: alias.tool, input }
	const renamed = alias.renamed ?? {}
	const sent = Rec.fromEntries(
		Arr.map(Rec.toEntries(Predicate.isObject(input) ? input : {}), ([key, value]) => [
			typeof key === "string" ? (renamed[key] ?? key) : key,
			value,
		]),
	)
	return { name: alias.tool, input: { ...sent, ...alias.args } }
}
