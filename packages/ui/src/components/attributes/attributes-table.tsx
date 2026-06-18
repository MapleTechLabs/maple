"use client"

import { ChevronRightIcon } from "../icons"
import { cn } from "../../lib/utils"
import { useClipboard } from "../../hooks/use-clipboard"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "../ui/collapsible"
import { groupAttributesByNamespace } from "../../lib/log-attributes"
import { CollapsibleJsonValue } from "./json-value"
import { useAttributesConfig } from "./context"

export function CopyableValue({
	value,
	children,
	className,
}: {
	value: string
	children?: React.ReactNode
	className?: string
}) {
	const clipboard = useClipboard()
	const { notifyCopied } = useAttributesConfig()

	return (
		<span
			className={cn(
				"cursor-pointer hover:bg-muted/50 rounded px-0.5 -mx-0.5 transition-colors",
				className,
			)}
			onClick={() => {
				clipboard.copy(value)
				notifyCopied?.()
			}}
			title="Click to copy"
		>
			{children ?? value}
		</span>
	)
}

export function tryParseJson(value: string): unknown | null {
	const trimmed = value.trimStart()
	if (trimmed[0] !== "{" && trimmed[0] !== "[") return null
	try {
		return JSON.parse(value)
	} catch {
		return null
	}
}

function AttributeRow({
	attrKey,
	value,
	displayKey,
}: {
	attrKey: string
	value: string
	/** Label shown in the key column; defaults to `attrKey`. Copies still use the full `attrKey`. */
	displayKey?: string
}) {
	const { renderValue } = useAttributesConfig()
	const parsed = tryParseJson(value)
	// Apps may enrich specific keys (e.g. a commit SHA → hover card). Only the
	// non-JSON branch is overridable; JSON values keep their collapsible renderer.
	const override = parsed === null ? renderValue?.(attrKey, value) : null
	return (
		<div className="grid grid-cols-[minmax(7rem,38%)_1fr] items-start gap-x-3 px-2 py-1 transition-colors hover:bg-muted/40">
			<CopyableValue
				value={attrKey}
				className="font-mono text-[11px] leading-relaxed text-muted-foreground break-words"
			>
				{displayKey ?? attrKey}
			</CopyableValue>
			<div className="min-w-0 font-mono text-[11px] leading-relaxed text-foreground break-all">
				{parsed !== null ? (
					<CollapsibleJsonValue value={value} parsed={parsed} />
				) : override != null ? (
					override
				) : (
					<CopyableValue value={value}>{value}</CopyableValue>
				)}
			</div>
		</div>
	)
}

/**
 * Drops the namespace prefix from a key for display inside its group
 * (e.g. `k8s.pod.name` → `pod.name` under the `k8s` header). The group header
 * already names the namespace, so the leaf is enough — and it keeps the key
 * column tight. Returns the full key unchanged for the synthetic `Other` group
 * or anything that doesn't actually start with `namespace.`.
 */
function stripNamespace(key: string, namespace: string): string {
	if (namespace === "Other") return key
	const prefix = `${namespace}.`
	return key.startsWith(prefix) ? key.slice(prefix.length) : key
}

function filterEntries(entries: Array<[string, string]>, searchQuery?: string): Array<[string, string]> {
	if (!searchQuery) return entries
	const q = searchQuery.toLowerCase()
	return entries.filter(([key, value]) => key.toLowerCase().includes(q) || value.toLowerCase().includes(q))
}

export interface AttributesTableProps {
	attributes: Record<string, string>
	title: string
	searchQuery?: string
	groupByNamespace?: boolean
}

export function AttributesTable({ attributes, title, searchQuery, groupByNamespace }: AttributesTableProps) {
	const allEntries = Object.entries(attributes)

	if (allEntries.length === 0) {
		return <div className="text-xs text-muted-foreground py-2">No {title.toLowerCase()} available</div>
	}

	if (groupByNamespace) {
		const groups = groupAttributesByNamespace(attributes)
			.map((group) => ({ ...group, entries: filterEntries(group.entries, searchQuery) }))
			.filter((group) => group.entries.length > 0)

		if (groups.length === 0) {
			return (
				<div className="space-y-1.5">
					<h4 className="text-xs font-medium tracking-wide text-foreground/70">{title}</h4>
					<div className="text-xs text-muted-foreground py-2">
						No {title.toLowerCase()} match "{searchQuery}"
					</div>
				</div>
			)
		}

		return (
			<div className="space-y-1.5">
				<h4 className="text-xs font-medium tracking-wide text-foreground/70">{title}</h4>
				<div className="divide-y divide-border/60 overflow-hidden rounded-md border">
					{groups.map((group) => (
						<Collapsible
							key={group.namespace}
							defaultOpen={group.entries.length <= 8 || !!searchQuery}
						>
							<CollapsibleTrigger className="group flex w-full items-center gap-1.5 px-1.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground">
								<ChevronRightIcon
									size={11}
									className="transition-transform group-data-[panel-open]:rotate-90"
								/>
								<span className="font-mono font-semibold text-foreground/80">
									{group.namespace}
								</span>
								<span className="ml-auto rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
									{group.entries.length}
								</span>
							</CollapsibleTrigger>
							<CollapsibleContent>
								<div className="divide-y divide-border/40 border-t border-border/60 bg-muted/15">
									{group.entries.map(([key, value]) => (
										<AttributeRow
											key={key}
											attrKey={key}
											value={value}
											displayKey={stripNamespace(key, group.namespace)}
										/>
									))}
								</div>
							</CollapsibleContent>
						</Collapsible>
					))}
				</div>
			</div>
		)
	}

	const filtered = filterEntries(allEntries, searchQuery)

	if (filtered.length === 0) {
		return (
			<div className="space-y-1.5">
				<h4 className="text-xs font-medium tracking-wide text-foreground/70">{title}</h4>
				<div className="text-xs text-muted-foreground py-2">
					No {title.toLowerCase()} match "{searchQuery}"
				</div>
			</div>
		)
	}

	return (
		<div className="space-y-1.5">
			<h4 className="text-xs font-medium tracking-wide text-foreground/70">{title}</h4>
			<div className="divide-y divide-border/60 overflow-hidden rounded-md border">
				{filtered.map(([key, value]) => (
					<AttributeRow key={key} attrKey={key} value={value} />
				))}
			</div>
		</div>
	)
}

function partitionResourceAttributes(attrs: Record<string, string>) {
	const standard: Record<string, string> = {}
	const internal: Record<string, string> = {}
	for (const [key, value] of Object.entries(attrs)) {
		if (key.startsWith("maple_")) {
			internal[key] = value
		} else {
			standard[key] = value
		}
	}
	return { standard, internal }
}

export function ResourceAttributesSection({
	attributes,
	searchQuery,
	groupByNamespace,
}: {
	attributes: Record<string, string>
	searchQuery?: string
	groupByNamespace?: boolean
}) {
	const { standard, internal } = partitionResourceAttributes(attributes)
	const internalCount = Object.keys(internal).length

	return (
		<div className="space-y-2">
			<AttributesTable
				attributes={standard}
				title="Resource Attributes"
				searchQuery={searchQuery}
				groupByNamespace={groupByNamespace}
			/>
			{internalCount > 0 && (
				<Collapsible>
					<CollapsibleTrigger className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors group">
						<ChevronRightIcon
							size={10}
							className="transition-transform group-data-[panel-open]:rotate-90"
						/>
						Maple Internal ({internalCount})
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div className="mt-1">
							<AttributesTable
								attributes={internal}
								title="Maple Internal"
								searchQuery={searchQuery}
							/>
						</div>
					</CollapsibleContent>
				</Collapsible>
			)}
		</div>
	)
}
