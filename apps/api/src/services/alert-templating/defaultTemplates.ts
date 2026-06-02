/**
 * Built-in default notification templates.
 *
 * These reproduce the information of Maple's hardcoded notification format using
 * the `{{ variable }}` grammar. They are used to seed the rule editor and power
 * the live preview. NOTE: at dispatch time, a rule with NO custom template still
 * takes the original hardcoded formatter path (see AlertDeliveryDispatch) — so
 * these defaults are presentational, and existing notifications are byte-for-byte
 * unchanged. When a user customizes the template, these are the starting point.
 */

export const DEFAULT_TITLE_TEMPLATE = "{{ event.emoji }} {{ rule.name }} — {{ event.label }}"

export const DEFAULT_BODY_TEMPLATE = [
	"*Severity:* {{ severity }}",
	"*Signal:* {{ signal.label }}",
	"*Group:* {{ group }}",
	"*Observed:* {{ observed.summary }}",
	"*Window:* {{ window }}",
].join("\n")
