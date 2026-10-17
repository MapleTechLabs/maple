import { useState } from "react"
import type { McpToolCatalogEntry } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@maple/ui/components/ui/collapsible"
import { SearchInput } from "@maple/ui/components/ui/search-input"
import { SkeletonList } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"
import { ChevronRightIcon } from "@/components/icons"
import { SettingsSection } from "@/components/settings/settings-section"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { MapleAiAtomClient } from "@/lib/services/common/ai-atom-client"
import { groupMcpTools, type McpToolGroup } from "./mcp-tool-groups"

/** Groups open on first view; the rest start collapsed. */
const OPEN_GROUPS = 3
/** Rows a group shows before "Show more". */
const PREVIEW_ROWS = 4

function ToolRow({ tool }: { tool: McpToolCatalogEntry }) {
	return (
		<li className="grid grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto] items-center gap-4 py-1.5 max-sm:grid-cols-[minmax(0,1fr)_auto]">
			<code className="truncate font-mono text-xs font-medium text-foreground">{tool.name}</code>
			<p className="truncate text-xs text-muted-foreground max-sm:hidden" title={tool.description}>
				{tool.description}
			</p>
			{tool.readOnly ? (
				<Badge variant="muted" size="sm">
					Read only
				</Badge>
			) : (
				<Badge variant="warn" size="sm">
					Writes
				</Badge>
			)}
		</li>
	)
}

function ToolGroup({
	group,
	open,
	onOpenChange,
	showAll,
	onShowAll,
}: {
	group: McpToolGroup
	open: boolean
	onOpenChange: (open: boolean) => void
	showAll: boolean
	onShowAll: () => void
}) {
	const hidden = showAll ? 0 : Math.max(0, group.tools.length - PREVIEW_ROWS)
	const rows = hidden === 0 ? group.tools : group.tools.slice(0, PREVIEW_ROWS)
	return (
		<Collapsible open={open} onOpenChange={onOpenChange}>
			<CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-muted/40">
				<ChevronRightIcon
					size={14}
					className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
				/>
				<span className="font-medium">{group.label}</span>
				<span className="text-xs text-muted-foreground tabular-nums">{group.tools.length}</span>
			</CollapsibleTrigger>
			<CollapsiblePanel className="px-4 pb-3 pl-10">
				<ul>
					{rows.map((tool) => (
						<ToolRow key={tool.name} tool={tool} />
					))}
				</ul>
				{hidden > 0 && (
					<Button
						variant="ghost"
						size="xs"
						className="-ml-2 mt-1 text-muted-foreground"
						onClick={onShowAll}
					>
						Show {hidden} more
					</Button>
				)}
			</CollapsiblePanel>
		</Collapsible>
	)
}

/** Toggles a member of a set without mutating it. */
const toggled = (set: ReadonlySet<string>, id: string) => {
	const next = new Set(set)
	if (next.has(id)) next.delete(id)
	else next.add(id)
	return next
}

function ToolCatalog({ tools }: { tools: ReadonlyArray<McpToolCatalogEntry> }) {
	const [search, setSearch] = useState("")
	// Groups whose open state differs from the default, so the default can depend on position.
	const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set())
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
	const searching = search.trim() !== ""
	const groups = groupMcpTools(tools, search)

	return (
		<>
			<div className="border-b p-2">
				<SearchInput
					value={search}
					onValueChange={setSearch}
					placeholder={`Search ${tools.length} tools`}
					aria-label="Search tools"
				/>
			</div>
			{groups.length === 0 ? (
				<p className="px-4 py-6 text-center text-sm text-muted-foreground">
					No tools match “{search}”.
				</p>
			) : (
				<div className="divide-y">
					{groups.map((group, index) => (
						<ToolGroup
							key={group.id}
							group={group}
							open={searching || index < OPEN_GROUPS !== flipped.has(group.id)}
							onOpenChange={() => {
								if (!searching) setFlipped((current) => toggled(current, group.id))
							}}
							showAll={searching || expanded.has(group.id)}
							onShowAll={() => setExpanded((current) => toggled(current, group.id))}
						/>
					))}
				</div>
			)}
		</>
	)
}

export function McpToolsList() {
	const result = useAtomValue(MapleAiAtomClient.query("mcpTools", "list", { timeToLive: "1 hour" }))
	const count = Result.builder(result)
		.onSuccess((catalog): number | null => catalog.tools.length)
		.orElse(() => null)

	return (
		<SettingsSection
			title={count === null ? "Tools" : `Tools · ${count}`}
			description="What a connected client can do. Tools marked Writes change data."
			padded={false}
		>
			{Result.builder(result)
				.onSuccess((catalog) => <ToolCatalog tools={catalog.tools} />)
				.onError(() => (
					<p className="px-4 py-6 text-center text-sm text-muted-foreground">
						The tool list could not be loaded.
					</p>
				))
				.orElse(() => (
					<div className="p-4">
						<SkeletonList rows={6} />
					</div>
				))}
		</SettingsSection>
	)
}
