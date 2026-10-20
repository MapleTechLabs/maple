import {
	activeFilterChips,
	type CloudflareFilterKey,
	type CloudflareFilters,
	FILTER_SECTION_LABEL,
	filterKeysFromServer,
} from "../../../../components/infra/cloudflare/filters"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { scopeChip } from "../../kit/scope-chip"

// `PanelScope`: what a panel is actually scoped to.

export type Trigger = (id: string) => ReadonlyArray<ChildAttribute>

const listNames = (keys: ReadonlyArray<CloudflareFilterKey>): string => {
	const names = keys.map((key) => FILTER_SECTION_LABEL[key].toLowerCase())
	if (names.length <= 1) return names[0] ?? ""
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

export type PanelScopeOptions = Readonly<{
	filters: CloudflareFilters
	ignoredFilters: ReadonlyArray<string> | undefined
	reason?: string
	/** The explanation tooltip's trigger id. */
	id: string
	trigger: Trigger
}>

/** The tooltip text behind `zone-wide` and `partial`. */
export const panelScopeExplanation = (
	options: Pick<PanelScopeOptions, "ignoredFilters" | "reason">,
): ReadonlyArray<string> => {
	const ignored = filterKeysFromServer(options.ignoredFilters)
	return [
		options.reason === undefined || options.reason === "" ? "" : `${options.reason}. `,
		listNames(ignored),
		" ",
		ignored.length === 1 ? "does" : "do",
		" not apply here.",
	]
}

export const panelScope = <M>(h: HtmlBuilder<M>, options: PanelScopeOptions): Html | undefined => {
	const active = activeFilterChips(options.filters)
	if (active.length === 0) return undefined
	const ignored = filterKeysFromServer(options.ignoredFilters)
	const honored = active.filter((chip) => !ignored.includes(chip.key))
	if (honored.length === 0) {
		return scopeChip(h, { tone: "muted", trigger: options.trigger(options.id) }, ["zone-wide"])
	}
	const shown = honored.slice(0, 2)
	const extra = honored.length - shown.length
	return h.span(
		[h.Class("inline-flex items-center gap-1")],
		[
			...shown.map((chip) => scopeChip(h, { className: "max-w-[20ch] truncate" }, [chip.label])),
			...(extra > 0 ? [scopeChip(h, { tone: "muted" }, ["+", String(extra)])] : []),
			...(ignored.length > 0
				? [scopeChip(h, { tone: "muted", trigger: options.trigger(options.id) }, ["partial"])]
				: []),
		],
	)
}
