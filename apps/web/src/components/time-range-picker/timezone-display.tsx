import { useMemo, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@maple/ui/components/ui/popover"
import { Input } from "@maple/ui/components/ui/input"
import { cn } from "@maple/ui/utils"
import { ChevronExpandYIcon } from "@/components/icons"
import { getBrowserTimeZone, SYSTEM_VALUE } from "@/atoms/timezone-preference-atoms"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatZoneOffsetLabel, getZoneOffsetMinutes } from "@/lib/time-utils"

const prettyZone = (zone: string) => zone.replace(/_/g, " ")

interface TzEntry {
	/** Stored preference value: an IANA zone, or null for "system default". */
	value: string | null
	offsetLabel: string
	offsetMinutes: number
	primary: string
	secondary?: string
	search: string
}

export function TimezoneDisplay() {
	const { selectedTimezone, effectiveTimezone, setSelectedTimezone, supportedTimezones } =
		useTimezonePreference()
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState("")

	// Precompute labels/offsets once — recomputing ~400 Intl offsets per render
	// (and per keystroke) would be wasteful.
	const { pinned, zones } = useMemo(() => {
		const browserZone = getBrowserTimeZone()
		const pinned: TzEntry[] = [
			{
				value: null,
				offsetLabel: formatZoneOffsetLabel(browserZone),
				offsetMinutes: getZoneOffsetMinutes(browserZone),
				primary: "System",
				secondary: prettyZone(browserZone),
				search: `system default ${prettyZone(browserZone)} ${browserZone} ${formatZoneOffsetLabel(
					browserZone,
				)}`.toLowerCase(),
			},
			{
				value: "UTC",
				offsetLabel: "UTC+0",
				offsetMinutes: 0,
				primary: "UTC",
				search: "utc coordinated universal time utc+0",
			},
		]

		const zones: TzEntry[] = supportedTimezones
			.filter((zone) => zone !== "UTC")
			.map((zone) => {
				const offsetLabel = formatZoneOffsetLabel(zone)
				return {
					value: zone,
					offsetLabel,
					offsetMinutes: getZoneOffsetMinutes(zone),
					primary: prettyZone(zone),
					search: `${prettyZone(zone)} ${zone} ${offsetLabel}`.toLowerCase(),
				}
			})
			.sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.primary.localeCompare(b.primary))

		return { pinned, zones }
	}, [supportedTimezones])

	// Re-filter only when the query (or the precomputed lists) change, not on
	// every render — the zone list is ~400 entries.
	const { filteredPinned, filteredZones } = useMemo(() => {
		const q = query.trim().toLowerCase()
		const matches = (entry: TzEntry) =>
			q === "" || entry.search.includes(q) || entry.offsetLabel.toLowerCase().includes(q)
		return { filteredPinned: pinned.filter(matches), filteredZones: zones.filter(matches) }
	}, [query, pinned, zones])
	const hasResults = filteredPinned.length > 0 || filteredZones.length > 0

	const activeValue = selectedTimezone ?? null

	const handleSelect = (value: string | null) => {
		setSelectedTimezone(value)
		setOpen(false)
		setQuery("")
	}

	const renderRow = (entry: TzEntry) => {
		const isActive = entry.value === activeValue
		return (
			<button
				key={entry.value ?? SYSTEM_VALUE}
				type="button"
				onClick={() => handleSelect(entry.value)}
				className={cn(
					"grid w-full grid-cols-[4.25rem_1fr] items-baseline gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60",
					isActive && "bg-muted/50",
				)}
			>
				<span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
					{entry.offsetLabel}
				</span>
				<span className="flex min-w-0 items-baseline gap-1.5">
					<span
						className={cn(
							"truncate text-xs",
							isActive ? "font-medium text-foreground" : "text-foreground/90",
						)}
					>
						{entry.primary}
					</span>
					{entry.secondary && (
						<span className="shrink-0 text-[10px] text-muted-foreground/70">
							{entry.secondary}
						</span>
					)}
				</span>
			</button>
		)
	}

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<div className="flex items-center justify-between gap-3 border-t border-border/70 bg-muted/20 px-4 py-2.5">
				<span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/80">
					Timezone
				</span>
				<PopoverTrigger
					render={
						<button
							type="button"
							className="group inline-flex items-center gap-1 rounded font-mono text-[11px] tracking-tight text-foreground/85 outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
							title="Change timezone"
						>
							<span>{formatZoneOffsetLabel(effectiveTimezone)}</span>
							<span className="text-muted-foreground/70">
								{" "}
								· {prettyZone(effectiveTimezone)}
							</span>
							<ChevronExpandYIcon className="size-3 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground" />
						</button>
					}
				/>
			</div>

			<PopoverContent align="end" className="w-[300px] p-0">
				<div className="border-b border-border/70 p-2">
					<Input
						autoFocus
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search name or offset (e.g. Berlin, +5:30)"
						className="h-8 text-xs"
					/>
				</div>
				<div className="max-h-[280px] overflow-y-auto p-1">
					{!hasResults && (
						<p className="px-2 py-6 text-center text-xs text-muted-foreground">
							No timezones found.
						</p>
					)}
					{filteredPinned.map(renderRow)}
					{filteredPinned.length > 0 && filteredZones.length > 0 && (
						<div className="mx-2 my-1 h-px bg-border/70" />
					)}
					{filteredZones.map(renderRow)}
				</div>
			</PopoverContent>
		</Popover>
	)
}
