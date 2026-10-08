import { useMemo } from "react"
import type { V2DashboardTemplate } from "@maple/domain/http/v2"
import { Button } from "@maple/ui/components/ui/button"
import { Toolbar, ToolbarSearch } from "@maple/ui/components/toolbar"
import { SkeletonList } from "@maple/ui/components/ui/skeleton"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { cn } from "@maple/ui/lib/utils"
import { rowSelectedClass } from "@maple/ui/components/ui/list-row"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"
import {
	ArrowRightIcon,
	CircleCheckIcon,
	CircleWarningIcon,
	MagnifierIcon,
	PlusIcon,
} from "@/components/icons"
import { ListSectionHeader } from "@/components/dashboard-builder/list-section-header"
import { FilteredEmpty } from "@/components/common/filtered-empty"
import { SegmentedSelect, type SegmentedOption } from "@/components/common/segmented-select"
import { templateIcon } from "./template-icons"
import {
	BLANK_TEMPLATE_ID,
	CATEGORY_LABELS,
	CATEGORY_ORDER,
	templateMatches,
	widgetCountLabel,
} from "./template-summary"
import type { TemplateReadiness } from "./use-template-readiness"

export type ReadinessFilter = "all" | "ready" | "needs-setup"

const READINESS_OPTIONS: ReadonlyArray<SegmentedOption<ReadinessFilter>> = [
	{ value: "all", label: "All" },
	{ value: "ready", label: "Ready" },
	{ value: "needs-setup", label: "Needs setup" },
]

interface TemplateListProps {
	templates: ReadonlyArray<V2DashboardTemplate>
	readiness: ReadonlyMap<string, TemplateReadiness>
	selectedId: string | null
	onSelect: (template: V2DashboardTemplate) => void
	onSelectBlank: () => void
	query: string
	onQueryChange: (query: string | undefined) => void
	filter: ReadinessFilter
	onFilterChange: (filter: ReadinessFilter) => void
	loading?: boolean
}

/** A row's lanes are fixed-width so names, counts and statuses form columns. */
function TemplateRow({
	template,
	readiness,
	selected,
	onSelect,
}: {
	template: V2DashboardTemplate
	readiness: TemplateReadiness | undefined
	selected: boolean
	onSelect: () => void
}) {
	const Icon = templateIcon(template.id, template.category)
	const status = readiness?.missingLabel ?? null

	return (
		<button
			type="button"
			onClick={onSelect}
			aria-current={selected ? "true" : undefined}
			className={cn(
				"flex min-h-9 w-full items-center text-left transition-colors",
				rowSelectedClass(selected),
				!selected && "hover:bg-muted/50",
			)}
		>
			<span className="flex min-w-0 grow items-center gap-2.5 py-2 pr-5 pl-4.5">
				<span
					className={cn(
						"flex size-5.5 shrink-0 items-center justify-center rounded-sm border border-border",
						selected ? "bg-background" : "bg-card",
					)}
				>
					<Icon size={12} className={status ? "text-muted-foreground" : "text-foreground"} />
				</span>
				<span
					className={cn(
						"min-w-0 grow truncate text-sm",
						selected ? "font-medium text-foreground" : "text-foreground",
					)}
				>
					{template.name}
				</span>
				<span className="text-muted-foreground w-18 shrink-0 text-right font-mono text-2xs">
					{widgetCountLabel(template)}
				</span>
				{/* The lane is fixed so statuses form a column; long metric
				    prefixes truncate and the tooltip recovers the full one. */}
				<TruncatedText
					mono
					text={status ?? undefined}
					className="text-muted-foreground/80 w-31.5 shrink-0 text-right text-2xs"
				/>
			</span>
		</button>
	)
}

export function TemplateList({
	templates,
	readiness,
	selectedId,
	onSelect,
	onSelectBlank,
	query,
	onQueryChange,
	filter,
	onFilterChange,
	loading = false,
}: TemplateListProps) {
	// The blank template is pinned below the scroll region as its own row, so it
	// is never part of the catalogue counts or the readiness split.
	const { ready, needsSetup, matched, total } = useMemo(() => {
		const listed = templates.filter((template) => template.id !== BLANK_TEMPLATE_ID)
		const searched = listed.filter((template) => templateMatches(template, query))
		const isReady = (template: V2DashboardTemplate) => readiness.get(template.id)?.ready !== false

		const readyList = searched.filter(isReady)
		const gatedList = searched.filter((template) => !isReady(template))

		return {
			ready: filter === "needs-setup" ? [] : readyList,
			needsSetup: filter === "ready" ? [] : gatedList,
			matched: searched.length,
			total: listed.length,
		}
	}, [templates, readiness, query, filter])

	// Category survives only as a thin sub-label inside Needs setup — it tells you
	// which part of your stack is unconfigured, which the flat Ready list doesn't need.
	const gatedByCategory = useMemo(() => {
		const buckets = new Map<string, V2DashboardTemplate[]>()
		for (const template of needsSetup) {
			const bucket = buckets.get(template.category) ?? []
			bucket.push(template)
			buckets.set(template.category, bucket)
		}
		return CATEGORY_ORDER.map((category) => ({
			category,
			templates: buckets.get(category) ?? [],
		})).filter((group) => group.templates.length > 0)
	}, [needsSetup])

	const searching = query.trim().length > 0
	const nothingMatched = !loading && matched === 0
	// `matched` counts search hits before the readiness filter, so a filter that
	// excludes every one of them empties both sections while `nothingMatched`
	// stays false. Without its own state that renders as a blank scroll region.
	const filterHidEverything = !loading && matched > 0 && ready.length + needsSetup.length === 0

	return (
		<div className="flex min-h-0 flex-col overflow-hidden">
			<Toolbar className="shrink-0 flex-nowrap gap-2.5 px-5">
				<ToolbarSearch
					query={query}
					onSearch={onQueryChange}
					placeholder="Search templates"
					className="min-w-0 grow"
				/>
				<SegmentedSelect<ReadinessFilter>
					options={READINESS_OPTIONS}
					value={filter}
					onChange={onFilterChange}
					size="sm"
					aria-label="Filter templates by readiness"
					className="shrink-0"
				/>
			</Toolbar>

			{searching && !loading && (
				<div className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-2 text-2xs">
					<span className="font-mono text-foreground">{matched}</span>
					<span className="text-muted-foreground">of {total} match name, description or tag</span>
				</div>
			)}

			<div className="min-h-0 grow overflow-y-auto">
				{loading ? (
					<SkeletonList rows={8} rowClassName="h-7 rounded-sm" gap="2" className="p-5" />
				) : nothingMatched && !searching ? (
					<Empty className="py-14">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<PlusIcon size={17} />
							</EmptyMedia>
							<EmptyTitle>No templates available</EmptyTitle>
							<EmptyDescription>Start from a blank dashboard instead.</EmptyDescription>
						</EmptyHeader>
						<Button variant="outline" size="sm" onClick={onSelectBlank}>
							Start blank
						</Button>
					</Empty>
				) : nothingMatched ? (
					<FilteredEmpty
						noun="templates"
						title={`No template matches “${query.trim()}”`}
						description="Try a shorter term. Or start blank and add the widgets you want."
						icon={<MagnifierIcon size={17} />}
						onClear={() => onQueryChange(undefined)}
						clearLabel="Clear search"
						className="py-14"
					/>
				) : filterHidEverything ? (
					<Empty className="py-14">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								{filter === "ready" ? (
									<CircleWarningIcon size={17} />
								) : (
									<CircleCheckIcon size={17} />
								)}
							</EmptyMedia>
							<EmptyTitle>
								{filter === "ready"
									? "None of these are ready yet"
									: "These are all ready to use"}
							</EmptyTitle>
							<EmptyDescription>
								{matched === 1 ? "The one template" : `All ${matched} templates`}{" "}
								{searching ? "matching your search" : "here"}{" "}
								{filter === "ready"
									? matched === 1
										? "still needs setup."
										: "still need setup."
									: "can already draw your data."}
							</EmptyDescription>
						</EmptyHeader>
						<Button variant="outline" size="sm" onClick={() => onFilterChange("all")}>
							Show all templates
						</Button>
					</Empty>
				) : (
					<>
						{ready.length > 0 && (
							<>
								<ListSectionHeader
									title="Ready for your data"
									count={ready.length}
									accent
									className="px-5 pt-4"
								/>
								{ready.map((template) => (
									<TemplateRow
										key={template.id}
										template={template}
										readiness={readiness.get(template.id)}
										selected={template.id === selectedId}
										onSelect={() => onSelect(template)}
									/>
								))}
							</>
						)}

						{needsSetup.length > 0 && (
							<>
								<ListSectionHeader
									title="Needs setup"
									count={needsSetup.length}
									note="these would render empty today"
									className={cn(
										"px-5 pt-4",
										ready.length > 0 && "mt-2 border-t border-border pt-6",
									)}
								/>
								{gatedByCategory.map(({ category, templates: group }) => (
									<div key={category}>
										<div className="text-muted-foreground/75 pt-3.5 pr-5 pb-1 pl-12.75 text-2xs">
											{CATEGORY_LABELS[category] ?? category}
										</div>
										{group.map((template) => (
											<TemplateRow
												key={template.id}
												template={template}
												readiness={readiness.get(template.id)}
												selected={template.id === selectedId}
												onSelect={() => onSelect(template)}
											/>
										))}
									</div>
								))}
							</>
						)}
					</>
				)}
			</div>

			<button
				type="button"
				onClick={onSelectBlank}
				className="flex shrink-0 items-center gap-2.5 border-t border-border bg-sidebar py-3 pr-5 pl-4.5 text-left transition-colors hover:bg-muted/50"
			>
				<span className="flex size-5.5 shrink-0 items-center justify-center rounded-sm border border-input border-dashed">
					<PlusIcon size={11} className="text-muted-foreground" />
				</span>
				<span className="flex min-w-0 grow items-baseline gap-2.25">
					<span className="text-sm text-foreground">Blank dashboard</span>
					<span className="text-muted-foreground text-2xs">start from nothing</span>
				</span>
				<ArrowRightIcon size={13} className="text-muted-foreground shrink-0" />
			</button>
		</div>
	)
}
