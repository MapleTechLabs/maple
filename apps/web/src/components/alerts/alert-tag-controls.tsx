import { useMemo, useState } from "react"

import { cn } from "@maple/ui/utils"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { Label } from "@maple/ui/components/ui/label"
import { Popover, PopoverPopup, PopoverTrigger } from "@maple/ui/components/ui/popover"
import { Toggle } from "@maple/ui/components/ui/toggle"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@maple/ui/components/ui/input-group"

import { ChevronDownIcon, LayersIcon, MagnifierIcon, TagIcon } from "@/components/icons"
import type { TagFacet } from "@/lib/alerts/tag-grouping"

interface AlertTagControlsProps {
	facets: TagFacet[]
	selected: string[]
	onSelectedChange: (tags: string[]) => void
	grouped: boolean
	onGroupedChange: (grouped: boolean) => void
}

/**
 * Tag filter (multi-select popover) + "Group by tag" toggle, shared by the
 * Rules and Monitor tabs. Renders nothing until at least one tag exists so the
 * controls stay out of the way for orgs that never tag their rules.
 */
export function AlertTagControls({
	facets,
	selected,
	onSelectedChange,
	grouped,
	onGroupedChange,
}: AlertTagControlsProps) {
	const [search, setSearch] = useState("")

	const visibleFacets = useMemo(() => {
		const q = search.trim().toLowerCase()
		return q ? facets.filter((f) => f.name.includes(q)) : facets
	}, [facets, search])

	if (facets.length === 0 && selected.length === 0) return null

	const toggleTag = (name: string) => {
		onSelectedChange(selected.includes(name) ? selected.filter((t) => t !== name) : [...selected, name])
	}

	return (
		<div className="flex items-center gap-2">
			<Popover>
				<PopoverTrigger
					render={
						<Button variant="outline" size="sm" className="gap-1.5">
							<TagIcon size={14} />
							Tags
							{selected.length > 0 && (
								<Badge size="sm" variant="secondary" className="tabular-nums">
									{selected.length}
								</Badge>
							)}
							<ChevronDownIcon size={14} className="text-muted-foreground" />
						</Button>
					}
				/>
				<PopoverPopup align="start" className="w-64 p-0">
					<div className="border-b border-border p-2">
						<InputGroup>
							<InputGroupAddon>
								<MagnifierIcon />
							</InputGroupAddon>
							<InputGroupInput
								size="sm"
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								placeholder="Filter tags…"
							/>
						</InputGroup>
					</div>
					<div className="max-h-64 overflow-y-auto p-1.5">
						{visibleFacets.length === 0 ? (
							<p className="px-1.5 py-2 text-xs text-muted-foreground">No matching tags</p>
						) : (
							visibleFacets.map((facet) => (
								<div
									key={facet.name}
									className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent/50"
								>
									<Checkbox
										id={`tag-filter-${facet.name}`}
										checked={selected.includes(facet.name)}
										onCheckedChange={() => toggleTag(facet.name)}
									/>
									<Label
										htmlFor={`tag-filter-${facet.name}`}
										className="flex-1 min-w-0 cursor-pointer truncate text-xs font-normal text-foreground"
										title={facet.name}
									>
										{facet.name}
									</Label>
									<span className="text-xs text-muted-foreground tabular-nums">
										{facet.count}
									</span>
								</div>
							))
						)}
					</div>
					{selected.length > 0 && (
						<div className="border-t border-border p-1.5">
							<Button
								variant="ghost"
								size="sm"
								className="w-full justify-start text-muted-foreground"
								onClick={() => onSelectedChange([])}
							>
								Clear {selected.length} selected
							</Button>
						</div>
					)}
				</PopoverPopup>
			</Popover>

			<Toggle
				variant="outline"
				size="sm"
				pressed={grouped}
				onPressedChange={onGroupedChange}
				className={cn("gap-1.5", grouped && "text-foreground")}
				aria-label="Group by tag"
			>
				<LayersIcon size={14} />
				Group by tag
			</Toggle>
		</div>
	)
}
