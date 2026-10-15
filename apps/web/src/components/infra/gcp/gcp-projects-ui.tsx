// A Google Cloud connection can cover many projects: a folder or an organization usually does.
// The menu and the strip render with two or more; one project keeps a plain chip.

import { Link } from "@tanstack/react-router"

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { Badge } from "@maple/ui/components/ui/badge"
import { formatPercent } from "@maple/ui/lib/format"
import { TONE_FILL, TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

import { ChevronDownIcon } from "@/components/icons"
import type { GcpProjectHealth } from "./list-model"

const ALL = "__all__"

/** Healthy reads as plain text; only a problem takes a colour. */
const healthText = (health: GcpProjectHealth | undefined) =>
	health === undefined || health.tone === "ok" || health.tone === "neutral"
		? "text-muted-foreground"
		: TONE_TEXT[health.tone]

function HealthDot({ health }: { health: GcpProjectHealth | undefined }) {
	if (health === undefined) return null
	return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_FILL[health.tone])} />
}

export function GcpProjectMenu({
	projects,
	counts,
	health,
	value,
	onChange,
}: {
	projects: ReadonlyArray<string>
	/** What each project holds: "9 services · 2 databases". */
	counts: (project: string) => string
	health: ReadonlyMap<string, GcpProjectHealth>
	/** A project, or undefined for all of them. */
	value: string | undefined
	onChange: (project: string | undefined) => void
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={<Badge variant="meta" size="xs" mono render={<button type="button" />} />}
				className="cursor-pointer gap-1 font-normal text-muted-foreground transition-colors hover:text-foreground"
			>
				{value === undefined ? "projects" : "project"}
				<span className="text-foreground">{value ?? `All ${projects.length}`}</span>
				<ChevronDownIcon className="size-3 opacity-60" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="min-w-80">
				<DropdownMenuRadioGroup
					value={value ?? ALL}
					onValueChange={(next) => onChange(next === ALL ? undefined : String(next))}
				>
					<DropdownMenuRadioItem value={ALL} closeOnClick>
						All projects
					</DropdownMenuRadioItem>
					<DropdownMenuSeparator />
					{projects.map((project) => {
						const projectHealth = health.get(project)
						return (
							<DropdownMenuRadioItem key={project} value={project} closeOnClick>
								<span className="flex items-start gap-2">
									<span className="mt-1.5 flex w-1.5 shrink-0">
										<HealthDot health={projectHealth} />
									</span>
									<span className="flex flex-col">
										<span className="font-mono">{project}</span>
										<span className={cn("text-3xs", healthText(projectHealth))}>
											{counts(project)}
											{projectHealth === undefined ? "" : ` · ${projectHealth.message}`}
										</span>
									</span>
								</span>
							</DropdownMenuRadioItem>
						)
					})}
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuItem render={<Link to="/integrations" search={{ integration: "gcp" }} />}>
					Manage connections
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

/**
 * One cell per project, the biggest share first: its share of the current view's volume, what it
 * holds, and the health of its own connection when it has one. A cell is a scope: click to see only
 * that project.
 */
export function GcpProjectsStrip({
	projects,
	share,
	counts,
	health,
	onSelect,
}: {
	projects: ReadonlyArray<string>
	/** Share of the current view's volume per project, 0-1. */
	share: ReadonlyMap<string, number>
	counts: (project: string) => string
	health: ReadonlyMap<string, GcpProjectHealth>
	onSelect: (project: string) => void
}) {
	return (
		<div className="flex flex-col overflow-hidden rounded-md border md:flex-row">
			{projects
				.toSorted((a, b) => (share.get(b) ?? 0) - (share.get(a) ?? 0))
				.map((project) => {
					const fraction = share.get(project) ?? 0
					const projectHealth = health.get(project)
					const problem = projectHealth !== undefined && projectHealth.tone !== "ok"
					return (
						<button
							key={project}
							type="button"
							onClick={() => onSelect(project)}
							className="flex min-w-0 flex-1 flex-col gap-2 border-b px-4 py-3 text-left transition-colors last:border-0 hover:bg-muted/40 md:border-b-0 md:border-l md:first:border-l-0"
						>
							<span className="flex items-center gap-2">
								<HealthDot health={projectHealth} />
								<span className="truncate font-mono text-xs font-medium text-foreground">
									{project}
								</span>
								<span className="ml-auto font-mono text-2xs tabular-nums text-foreground">
									{formatPercent(fraction)}
								</span>
							</span>
							<span className="block h-1 w-full overflow-hidden rounded-full bg-muted">
								<span
									className="block h-full rounded-full bg-muted-foreground/60"
									style={{ width: `${Math.max(fraction * 100, fraction > 0 ? 1.5 : 0)}%` }}
								/>
							</span>
							<span className={cn("truncate font-mono text-3xs", healthText(projectHealth))}>
								{problem ? projectHealth.message : counts(project)}
							</span>
						</button>
					)
				})}
		</div>
	)
}
