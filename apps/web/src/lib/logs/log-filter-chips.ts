import type { LogsSearchParams } from "@/routes/logs/index"
import { decodeLogAttributeFilter } from "@/lib/logs/log-attribute-filters"

/** One facet, in both polarities. `label` matches the sidebar section title exactly. */
const FACETS = [
	{ label: "Severity", include: "severities", exclude: "excludedSeverities" },
	{ label: "Service", include: "services", exclude: "excludedServices" },
	{ label: "Environment", include: "deploymentEnvs", exclude: "excludedDeploymentEnvs" },
	{ label: "Namespace", include: "namespaces", exclude: "excludedNamespaces" },
] as const satisfies ReadonlyArray<{
	label: string
	include: keyof LogsSearchParams
	exclude: keyof LogsSearchParams
}>

export interface LogFilterChipDescriptor {
	param: keyof LogsSearchParams
	label: string
	values: readonly string[]
	negated: boolean
	/** Set on attribute chips: the one `attrs` entry the chip removes, not the whole param. */
	attr?: string
}

/** The applied facet filters, exclusions first — see `traceFilterChips` for why they lead. */
export function logFilterChips(
	search: Pick<LogsSearchParams, (typeof FACETS)[number]["include" | "exclude"] | "traceId" | "attrs">,
): LogFilterChipDescriptor[] {
	const chips: LogFilterChipDescriptor[] = []
	// The trace scope leads even the exclusions: it redefines what the page shows
	// (one trace's logs) rather than trimming it, and it has no sidebar section.
	if (search.traceId) {
		chips.push({ param: "traceId", label: "Trace", values: [search.traceId], negated: false })
	}
	for (const facet of FACETS) {
		const excluded = search[facet.exclude]
		if (excluded?.length) {
			chips.push({ param: facet.exclude, label: facet.label, values: excluded, negated: true })
		}
	}
	// One chip per attribute filter, so each can be removed on its own.
	const attrs = (search.attrs ?? []).flatMap((entry) => {
		const filter = decodeLogAttributeFilter(entry)
		return filter ? [{ entry, filter }] : []
	})
	for (const { entry, filter } of attrs.filter((a) => a.filter.negated)) {
		chips.push({ param: "attrs", label: filter.key, values: [filter.value], negated: true, attr: entry })
	}
	for (const facet of FACETS) {
		const included = search[facet.include]
		if (included?.length) {
			chips.push({ param: facet.include, label: facet.label, values: included, negated: false })
		}
	}
	for (const { entry, filter } of attrs.filter((a) => !a.filter.negated)) {
		chips.push({ param: "attrs", label: filter.key, values: [filter.value], negated: false, attr: entry })
	}
	return chips
}

/**
 * The search with the given chips' filters removed. A facet chip clears its whole
 * param; an attribute chip drops only its own `attrs` entry.
 */
export function withoutChips<S extends Pick<LogsSearchParams, "attrs">>(
	search: S,
	chips: readonly LogFilterChipDescriptor[],
): S {
	const cleared = Object.fromEntries(
		chips.filter((chip) => chip.attr === undefined).map((chip) => [chip.param, undefined]),
	)
	const dropped = new Set(chips.flatMap((chip) => (chip.attr === undefined ? [] : [chip.attr])))
	const attrs = (search.attrs ?? []).filter((entry) => !dropped.has(entry))
	return { ...search, ...cleared, attrs: attrs.length > 0 ? attrs : undefined }
}
