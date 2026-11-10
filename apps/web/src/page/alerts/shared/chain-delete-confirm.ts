import type { V2EscalationChain } from "@maple/domain/http/v2"
import { pluralize } from "@maple/ui/lib/format"
import { Option, Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { typography } from "@maple/views/ui/typography"

export type ChainDeleteConfirm = Readonly<{
	/** A rule still starts the chain: the API refuses the delete, so the confirm holds it. */
	isInUse: boolean
	description: string
	/** The rules that start it by name; ones this tab has not loaded are counted. */
	ruleList: ReadonlyArray<Html>
}>

/**
 * What a chain's delete confirm says, on its own page and on its Routing row: the rules that
 * start it, which the API makes move off it first, and Delete held while there are any.
 */
export const chainDeleteConfirm = <M>(
	h: HtmlBuilder<M>,
	chain: Option.Option<Pick<V2EscalationChain, "rule_ids">>,
	rules: ReadonlyArray<{ readonly id: string; readonly name: string }> | null,
): ChainDeleteConfirm => {
	const ruleIds: ReadonlyArray<string> = Option.match(chain, {
		onNone: () => [],
		onSome: (found) => found.rule_ids,
	})
	const names = Arr.map(
		Arr.filter(rules ?? [], (rule) => Arr.some(ruleIds, (id) => id === rule.id)),
		(rule) => rule.name,
	)
	if (ruleIds.length === 0)
		return {
			isInUse: false,
			description: "Escalations already running finish on their own copy. This cannot be undone.",
			ruleList: [],
		}
	return {
		isInUse: true,
		description:
			ruleIds.length === 1
				? "This rule would stop escalating. Remove the chain from its severity tiers first."
				: "These rules would stop escalating. Remove the chain from their severity tiers first.",
		ruleList: [
			h.ul(
				[h.Class("list-disc space-y-1 pl-5")],
				[
					...Arr.map(names, (ruleName) =>
						h.li([h.Key(ruleName)], [typography(h, { size: "sm" }, [ruleName])]),
					),
					...(ruleIds.length > names.length
						? [
								h.li(
									[],
									[
										typography(h, { size: "sm", tone: "muted" }, [
											names.length === 0
												? `${ruleIds.length} ${pluralize(ruleIds.length, "rule")}`
												: `and ${ruleIds.length - names.length} more`,
										]),
									],
								),
							]
						: []),
				],
			),
		],
	}
}
