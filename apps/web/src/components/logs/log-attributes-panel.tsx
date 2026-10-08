import { useCallback, useState } from "react"
import { SearchInput } from "@maple/ui/components/ui/search-input"
import { AttributesProvider, type AttributesConfig } from "@maple/ui/components/attributes"
import { AttributesSection, ResourceAttributesSection } from "@/components/attributes"
import type { Log } from "@/api/warehouse/logs"
import type { LogAttributeFilter, LogAttributeSource } from "@/lib/logs/log-attribute-filters"

type FilterByAttribute = NonNullable<AttributesConfig["onFilterByAttribute"]>

interface LogAttributesPanelProps {
	log: Log
	/** Gives every attribute row "Filter" / "Exclude" hover actions. Omit for read-only. */
	onAttributeFilter?: (filter: LogAttributeFilter) => void
}

/** The table's row-level filter callback, bound to the map the section shows. */
function useSectionFilter(
	source: LogAttributeSource,
	onAttributeFilter: LogAttributesPanelProps["onAttributeFilter"],
): FilterByAttribute | undefined {
	const handler = useCallback<FilterByAttribute>(
		({ attrKey, value, action }) =>
			onAttributeFilter?.({ source, key: attrKey, value, negated: action === "exclude" }),
		[source, onAttributeFilter],
	)
	return onAttributeFilter ? handler : undefined
}

/**
 * Searchable log + resource attribute tables. Owns its own search state;
 * remount (via `key`) to reset it when the displayed log changes.
 */
export function LogAttributesPanel({ log, onAttributeFilter }: LogAttributesPanelProps) {
	const [attrSearch, setAttrSearch] = useState("")
	const filterLog = useSectionFilter("log", onAttributeFilter)
	const filterResource = useSectionFilter("resource", onAttributeFilter)

	const hasAttributes =
		Object.keys(log.logAttributes).length > 0 || Object.keys(log.resourceAttributes).length > 0

	return (
		<div className="space-y-3">
			{hasAttributes && (
				<SearchInput
					value={attrSearch}
					onValueChange={setAttrSearch}
					placeholder="Search attributes..."
				/>
			)}

			<AttributesProvider onFilterByAttribute={filterLog}>
				<AttributesSection
					attributes={log.logAttributes}
					title="Log Attributes"
					searchQuery={attrSearch}
					groupByNamespace
				/>
			</AttributesProvider>

			<AttributesProvider onFilterByAttribute={filterResource}>
				<ResourceAttributesSection
					attributes={log.resourceAttributes}
					searchQuery={attrSearch}
					groupByNamespace
				/>
			</AttributesProvider>
		</div>
	)
}
