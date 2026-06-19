// Checkbox filter sections for the filter sidebar — mirrors the web app's
// `@/components/filters/filter-section` so local mode reads as the same product.

import * as React from "react"
import { ChevronDownIcon, MagnifierIcon, XmarkIcon } from "@maple/ui/components/icons"
import { cn } from "@maple/ui/utils"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { Label } from "@maple/ui/components/ui/label"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@maple/ui/components/ui/collapsible"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"

export interface FilterOption {
	name: string
	count: number
}

interface FilterSectionBaseProps {
	title: string
	options: FilterOption[]
	selected: string[]
	onChange: (selected: string[]) => void
	defaultOpen?: boolean
	maxVisible?: number
	colorMap?: Record<string, string>
}

function FilterSectionBase({
	title,
	options,
	selected,
	onChange,
	defaultOpen = true,
	maxVisible = 5,
	searchable,
	colorMap,
}: FilterSectionBaseProps & { searchable: boolean }) {
	const [isOpen, setIsOpen] = React.useState(defaultOpen)
	const [showAll, setShowAll] = React.useState(false)
	const [searchText, setSearchText] = React.useState("")
	const inputRef = React.useRef<HTMLInputElement>(null)

	const filteredOptions =
		searchable && searchText
			? options.filter((o) => o.name.toLowerCase().includes(searchText.toLowerCase()))
			: options

	const visibleOptions = showAll || searchText ? filteredOptions : filteredOptions.slice(0, maxVisible)
	const hasMore = !searchText && filteredOptions.length > maxVisible

	const toggleOption = (name: string) => {
		if (selected.includes(name)) {
			onChange(selected.filter((s) => s !== name))
		} else {
			onChange([...selected, name])
		}
	}

	const handleOpenChange = (open: boolean) => {
		setIsOpen(open)
		if (!open) {
			setSearchText("")
			setShowAll(false)
		}
	}

	if (options.length === 0) {
		return null
	}

	return (
		<Collapsible open={isOpen} onOpenChange={handleOpenChange}>
			<CollapsibleTrigger className="flex w-full items-center justify-between py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
				<span>{title}</span>
				<ChevronDownIcon className={cn("size-4 transition-transform", isOpen && "rotate-180")} />
			</CollapsibleTrigger>
			<CollapsibleContent className="pb-3">
				{searchable && (
					<InputGroup className="mb-2">
						<InputGroupAddon>
							<MagnifierIcon />
						</InputGroupAddon>
						<InputGroupInput
							ref={inputRef}
							size="sm"
							value={searchText}
							onChange={(e) => {
								setSearchText(e.target.value)
								setShowAll(false)
							}}
							placeholder={`Search ${title.toLowerCase()}...`}
						/>
						{searchText && (
							<InputGroupAddon align="inline-end">
								<InputGroupButton
									aria-label="Clear search"
									onClick={() => {
										setSearchText("")
										inputRef.current?.focus()
									}}
								>
									<XmarkIcon />
								</InputGroupButton>
							</InputGroupAddon>
						)}
					</InputGroup>
				)}
				<div className="space-y-2">
					{visibleOptions.length === 0 ? (
						<p className="py-1 text-xs text-muted-foreground">No matches found</p>
					) : (
						visibleOptions.map((option) => (
							<div key={option.name} className="flex items-center gap-2">
								<Checkbox
									id={`${title}-${option.name}`}
									checked={selected.includes(option.name)}
									onCheckedChange={() => toggleOption(option.name)}
								/>
								<Label
									htmlFor={`${title}-${option.name}`}
									className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-xs font-normal text-foreground"
									title={option.name}
								>
									{colorMap?.[option.name] && (
										<span
											className="size-2.5 shrink-0 rounded-full"
											style={{ backgroundColor: colorMap[option.name] }}
										/>
									)}
									<span className="truncate">{option.name}</span>
								</Label>
								<span className="text-xs tabular-nums text-muted-foreground">
									{option.count.toLocaleString()}
								</span>
							</div>
						))
					)}
					{hasMore && (
						<button
							type="button"
							onClick={() => setShowAll(!showAll)}
							className="text-xs text-primary hover:underline"
						>
							{showAll ? "Show less" : `Show ${options.length - maxVisible} more`}
						</button>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
}

export function FilterSection(props: FilterSectionBaseProps) {
	return <FilterSectionBase {...props} searchable={false} />
}

export function SearchableFilterSection(props: Omit<FilterSectionBaseProps, "colorMap">) {
	return <FilterSectionBase {...props} searchable />
}

interface SingleCheckboxFilterProps {
	title: string
	checked: boolean
	onChange: (checked: boolean) => void
	count?: number
}

export function SingleCheckboxFilter({ title, checked, onChange, count }: SingleCheckboxFilterProps) {
	return (
		<div className="flex items-center gap-2 py-2">
			<Checkbox
				id={`filter-${title}`}
				checked={checked}
				onCheckedChange={(val) => onChange(val === true)}
			/>
			<Label
				htmlFor={`filter-${title}`}
				className="min-w-0 flex-1 cursor-pointer truncate text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
				title={title}
			>
				{title}
			</Label>
			{count !== undefined && (
				<span className="text-xs tabular-nums text-muted-foreground">{count.toLocaleString()}</span>
			)}
		</div>
	)
}
