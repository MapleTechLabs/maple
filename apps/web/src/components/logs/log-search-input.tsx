import { FILTER_SECTION_LABEL } from "@maple/ui/components/filters/filter-styles"
import { Kbd } from "@maple/ui/components/ui/kbd"
import { SearchInput } from "@maple/ui/components/ui/search-input"

import { LogSearchHelp } from "./log-search-help"

interface LogSearchInputProps {
	value: string
	onChange: (value: string) => void
}

/**
 * The logs search box. One field for two lookups (see `parseLogSearch`) — the
 * help sheet beside the label is where the shapes it accepts are listed, since
 * the placeholder has room for one of them at this width.
 */
export function LogSearchInput({ value, onChange }: LogSearchInputProps) {
	return (
		<div className="pb-3">
			<div className="flex items-center gap-1">
				<span className={`${FILTER_SECTION_LABEL} text-muted-foreground`}>Search</span>
				<LogSearchHelp />
			</div>
			<SearchInput
				className="mt-2"
				value={value}
				onValueChange={onChange}
				placeholder="Text or trace id"
				data-shortcut-focus="search"
				trailing={value ? null : <Kbd>/</Kbd>}
			/>
		</div>
	)
}
