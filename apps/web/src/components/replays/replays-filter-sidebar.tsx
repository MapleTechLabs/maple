import { useEffect, useState } from "react"
import { Result } from "@/lib/effect-atom"
import { useNavigate } from "@tanstack/react-router"

import {
	FilterSection,
	SearchableFilterSection,
	SingleCheckboxFilter,
	type FilterOption,
} from "@/components/filters/filter-section"
import { MagnifierIcon, XmarkIcon } from "@/components/icons"
import { Route } from "@/routes/replays"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { Label } from "@maple/ui/components/ui/label"
import { Separator } from "@maple/ui/components/ui/separator"
import {
	FilterSidebarBody,
	FilterSidebarError,
	FilterSidebarFrame,
	FilterSidebarHeader,
	FilterSidebarLoading,
} from "@/components/filters/filter-sidebar"
import { formatBackendError } from "@/lib/error-messages"

interface ReplaysFacetItem {
	readonly name: string
	readonly count: number
}

interface ReplaysFacets {
	readonly services: ReadonlyArray<ReplaysFacetItem>
	readonly browsers: ReadonlyArray<ReplaysFacetItem>
	readonly countries: ReadonlyArray<ReplaysFacetItem>
	readonly devices: ReadonlyArray<ReplaysFacetItem>
	readonly errorCount: number
}

// The facet branches exclude their own dimension server-side, so a selected
// value can vanish from its own option list. Re-inject it (count 0) so it stays
// checkable/uncheckable rather than silently disappearing.
function withSelected(options: ReadonlyArray<ReplaysFacetItem>, selected?: string): FilterOption[] {
	const list = options.map((o) => ({ name: o.name, count: o.count }))
	if (selected && !list.some((o) => o.name === selected)) {
		list.unshift({ name: selected, count: 0 })
	}
	return list
}

interface ReplaysFilterSidebarProps {
	facetsResult: Result.Result<ReplaysFacets, unknown>
}

export function ReplaysFilterSidebar({ facetsResult }: ReplaysFilterSidebarProps) {
	const navigate = useNavigate({ from: Route.fullPath })
	const search = Route.useSearch()

	// Single-value params: take the last toggled option (switching dimensions
	// replaces the prior value; unchecking the only one clears it).
	const setSingle = (key: "service" | "browser" | "country" | "deviceType", values: string[]) => {
		navigate({
			search: (prev) => ({ ...prev, [key]: values.at(-1) ?? undefined }),
		})
	}

	const toggleHasErrors = (checked: boolean) => {
		navigate({
			search: (prev) => ({ ...prev, hasErrors: checked || undefined }),
		})
	}

	const setUserId = (value: string | undefined) => {
		navigate({ search: (prev) => ({ ...prev, userId: value }) })
	}

	const clearAllFilters = () => {
		navigate({
			search: {
				startTime: search.startTime,
				endTime: search.endTime,
				timePreset: search.timePreset,
				q: search.q,
			},
		})
	}

	const hasActiveFilters =
		!!search.service ||
		!!search.browser ||
		!!search.country ||
		!!search.deviceType ||
		!!search.userId ||
		search.hasErrors === true

	return Result.builder(facetsResult)
		.onInitial(() => <FilterSidebarLoading sectionCount={5} />)
		.onError((error) => <FilterSidebarError message={formatBackendError(error).description} />)
		.onSuccess((facets, result) => {
			const services = withSelected(facets.services, search.service)
			const browsers = withSelected(facets.browsers, search.browser)
			const countries = withSelected(facets.countries, search.country)
			const devices = withSelected(facets.devices, search.deviceType)

			const hasFacets =
				services.length > 0 ||
				browsers.length > 0 ||
				countries.length > 0 ||
				devices.length > 0 ||
				facets.errorCount > 0

			return (
				<FilterSidebarFrame waiting={result.waiting}>
					<FilterSidebarHeader canClear={hasActiveFilters} onClear={clearAllFilters} />
					<FilterSidebarBody>
						<UserIdFilter value={search.userId} onApply={setUserId} />

						<Separator className="my-2" />

						<SingleCheckboxFilter
							title="Has errors"
							checked={search.hasErrors === true}
							onChange={toggleHasErrors}
							count={facets.errorCount}
						/>

						{services.length > 0 && (
							<>
								<Separator className="my-2" />
								<SearchableFilterSection
									title="Service"
									options={services}
									selected={search.service ? [search.service] : []}
									onChange={(vals) => setSingle("service", vals)}
								/>
							</>
						)}

						{browsers.length > 0 && (
							<>
								<Separator className="my-2" />
								<SearchableFilterSection
									title="Browser"
									options={browsers}
									selected={search.browser ? [search.browser] : []}
									onChange={(vals) => setSingle("browser", vals)}
								/>
							</>
						)}

						{devices.length > 0 && (
							<>
								<Separator className="my-2" />
								<FilterSection
									title="Device"
									options={devices}
									selected={search.deviceType ? [search.deviceType] : []}
									onChange={(vals) => setSingle("deviceType", vals)}
								/>
							</>
						)}

						{countries.length > 0 && (
							<>
								<Separator className="my-2" />
								<SearchableFilterSection
									title="Country"
									options={countries}
									selected={search.country ? [search.country] : []}
									onChange={(vals) => setSingle("country", vals)}
								/>
							</>
						)}

						{!hasFacets && (
							<p className="py-4 text-sm text-muted-foreground">
								No sessions in the selected time range
							</p>
						)}
					</FilterSidebarBody>
				</FilterSidebarFrame>
			)
		})
		.render()
}

// UserId is high-cardinality identity data, so it's a typed exact-match field
// rather than a facet checklist. Exact match means partial input matches nothing,
// so the filter commits on Enter (not per-keystroke) — mirrors the toolbar's
// local-state-synced input. The × clears both the field and the applied filter.
interface UserIdFilterProps {
	value: string | undefined
	onApply: (value: string | undefined) => void
}

function UserIdFilter({ value, onApply }: UserIdFilterProps) {
	const [text, setText] = useState(value ?? "")

	// Keep in sync when userId changes elsewhere (Clear all, the active-user chip's ×).
	useEffect(() => {
		setText(value ?? "")
	}, [value])

	const clear = () => {
		setText("")
		onApply(undefined)
	}

	return (
		<form
			className="py-2"
			onSubmit={(e) => {
				e.preventDefault()
				onApply(text.trim() || undefined)
			}}
		>
			<Label htmlFor="replays-user-filter" className="mb-2 block text-sm font-medium text-muted-foreground">
				User
			</Label>
			<InputGroup>
				<InputGroupAddon>
					<MagnifierIcon />
				</InputGroupAddon>
				<InputGroupInput
					id="replays-user-filter"
					size="sm"
					value={text}
					onChange={(e) => setText(e.target.value)}
					placeholder="Filter by user ID…"
				/>
				{text && (
					<InputGroupAddon align="inline-end">
						<InputGroupButton aria-label="Clear user filter" onClick={clear}>
							<XmarkIcon />
						</InputGroupButton>
					</InputGroupAddon>
				)}
			</InputGroup>
		</form>
	)
}
