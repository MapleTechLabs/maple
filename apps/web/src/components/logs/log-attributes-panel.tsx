import { useState } from "react"
import { MagnifierIcon, XmarkIcon } from "@/components/icons"
import { Input } from "@maple/ui/components/ui/input"
import { AttributesTable, ResourceAttributesSection } from "@/components/attributes"
import type { Log } from "@/api/warehouse/logs"

interface LogAttributesPanelProps {
	log: Log
}

/**
 * Searchable log + resource attribute tables. Owns its own search state;
 * remount (via `key`) to reset it when the displayed log changes.
 */
export function LogAttributesPanel({ log }: LogAttributesPanelProps) {
	const [attrSearch, setAttrSearch] = useState("")

	const hasAttributes =
		Object.keys(log.logAttributes).length > 0 || Object.keys(log.resourceAttributes).length > 0

	return (
		<div className="space-y-3">
			{hasAttributes && (
				<div className="relative">
					<MagnifierIcon
						strokeWidth={2}
						className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none"
					/>
					<Input
						type="text"
						value={attrSearch}
						onChange={(e) => setAttrSearch(e.target.value)}
						placeholder="Search attributes..."
						className="h-7 pl-7 pr-7 text-xs"
					/>
					{attrSearch && (
						<button
							type="button"
							onClick={() => setAttrSearch("")}
							className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
						>
							<XmarkIcon strokeWidth={2} className="size-3" />
						</button>
					)}
				</div>
			)}

			<AttributesTable
				attributes={log.logAttributes}
				title="Log Attributes"
				searchQuery={attrSearch}
				groupByNamespace
			/>

			<ResourceAttributesSection
				attributes={log.resourceAttributes}
				searchQuery={attrSearch}
				groupByNamespace
			/>
		</div>
	)
}
