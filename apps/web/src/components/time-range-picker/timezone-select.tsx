import { useMemo, useRef, useState } from "react"
import {
	Combobox,
	ComboboxChipsInput,
	ComboboxCollection,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxGroup,
	ComboboxItem,
	ComboboxList,
	ComboboxTrigger,
} from "@maple/ui/components/ui/combobox"
import { cn } from "@maple/ui/lib/utils"

import { getBrowserTimeZone, SYSTEM_VALUE } from "@/atoms/timezone-preference-atoms"
import { ChevronDownIcon, GlobeIcon } from "@/components/icons"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"

// One formatter per zone, built on first sight. The list holds ~430 zones and
// is rendered once per open, so the miss cost is paid once per session. The
// offset and clock are read at format time, so a DST change is picked up on
// the next open.
const offsetFormatters = new Map<string, Intl.DateTimeFormat>()
const clockFormatters = new Map<string, Intl.DateTimeFormat>()

/** `UTC+2`, `UTC-5:30`, `UTC` — the offset a zone is on at `at`. */
export function formatUtcOffset(timeZone: string, at: Date = new Date()): string {
	let formatter = offsetFormatters.get(timeZone)
	if (!formatter) {
		try {
			formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
		} catch {
			return "UTC"
		}
		offsetFormatters.set(timeZone, formatter)
	}
	const part = formatter.formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT"
	// "GMT" → "UTC", "GMT+2" → "UTC+2", "GMT+05:30" → "UTC+5:30"
	const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(part)
	if (!match) return "UTC"
	const [, sign, hours, minutes] = match
	return `UTC${sign}${Number(hours)}${minutes && minutes !== "00" ? `:${minutes}` : ""}`
}

/** Minutes east of UTC at `at`; the sort key behind the offset groups. */
function utcOffsetMinutes(timeZone: string, at: Date): number {
	const match = /^UTC([+-])(\d{1,2})(?::(\d{2}))?$/.exec(formatUtcOffset(timeZone, at))
	if (!match) return 0
	const [, sign, hours, minutes] = match
	return (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes ?? 0))
}

/** `16:52` — what the clock reads in `timeZone` right now. */
function formatClock(timeZone: string, at: Date): string {
	let formatter = clockFormatters.get(timeZone)
	if (!formatter) {
		try {
			formatter = new Intl.DateTimeFormat("en-GB", {
				timeZone,
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			})
		} catch {
			return "--:--"
		}
		clockFormatters.set(timeZone, formatter)
	}
	return formatter.format(at)
}

const PINNED_GROUP = "pinned"
const ZONES_GROUP = "zones"

interface ZoneGroup {
	value: string
	items: string[]
}

/** `Europe/Berlin` → `Europe` + `Berlin`; `America/Argentina/San_Juan` → `America` + `Argentina / San Juan`. */
function splitZone(zone: string): { region: string; city: string } {
	const slash = zone.indexOf("/")
	if (slash === -1) return { region: "Other", city: zone }
	return {
		region: zone.slice(0, slash),
		city: zone
			.slice(slash + 1)
			.replaceAll("_", " ")
			.replaceAll("/", " / "),
	}
}

/** System and UTC pinned above a separator; every other zone west to east by the offset it is on at `at`, A–Z within an offset. */
function groupZones(zones: ReadonlyArray<string>, at: Date): ZoneGroup[] {
	const sorted = zones
		.filter((zone) => zone !== "UTC")
		.map((zone) => ({ zone, minutes: utcOffsetMinutes(zone, at) }))
		.sort((a, b) => a.minutes - b.minutes || a.zone.localeCompare(b.zone))
		.map(({ zone }) => zone)
	return [
		{ value: PINNED_GROUP, items: [SYSTEM_VALUE, "UTC"] },
		{ value: ZONES_GROUP, items: sorted },
	]
}

function resolveZone(item: string): string {
	return item === SYSTEM_VALUE ? getBrowserTimeZone() : item
}

function itemLabel(item: string): string {
	return item === SYSTEM_VALUE ? `System (${getBrowserTimeZone()})` : item
}

/**
 * Matches the zone id, its offset, or the time it is there right now — so
 * `17:20` finds every zone whose clock currently reads that, which is how
 * people usually know a colleague's timezone.
 */
function matchesQuery(item: string, query: string, at: Date): boolean {
	const needle = query.trim().toLowerCase().replaceAll("_", " ")
	if (needle.length === 0) return true
	const zone = resolveZone(item)
	const haystack = `${itemLabel(item)} ${formatUtcOffset(zone, at)} ${formatClock(zone, at)}`
		.toLowerCase()
		.replaceAll("_", " ")
	return haystack.includes(needle)
}

/**
 * The picker footer's timezone control: a compact `zone · UTC±n` trigger that
 * opens a searchable list of every IANA zone the runtime knows, ordered west
 * to east, with the browser's own zone pinned first as "System" and UTC second.
 *
 * Writes `timezonePreferenceAtom`, so every timestamp the app prints follows
 * the choice — the picker is just where it is discoverable.
 */
export function TimezoneSelect() {
	const { selectedTimezone, effectiveTimezone, setSelectedTimezone, supportedTimezones } =
		useTimezonePreference()
	// The popup is anchored to the whole footer row, not the trigger, so it
	// spans exactly the picker's width instead of hanging past its left edge.
	const anchor = useRef<HTMLDivElement | null>(null)
	// Frozen per open: a clock that ticks while you scroll the list is noise.
	const [now, setNow] = useState(() => new Date())

	const groups = useMemo(() => groupZones(supportedTimezones, now), [supportedTimezones, now])
	const value = selectedTimezone ?? SYSTEM_VALUE

	return (
		<div
			ref={anchor}
			className="flex items-center justify-between gap-3 border-t border-border/70 bg-muted/20 px-4 py-2"
		>
			<span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/80">
				Timezone
			</span>
			<Combobox
				items={groups}
				autoHighlight
				itemToStringLabel={itemLabel}
				filter={(item: string, query: string) => matchesQuery(item, query, now)}
				value={value}
				onOpenChange={(open) => {
					if (open) setNow(new Date())
				}}
				onValueChange={(next) => {
					if (typeof next !== "string" || next.length === 0) return
					setSelectedTimezone(next === SYSTEM_VALUE ? null : next)
				}}
			>
				<ComboboxTrigger
					aria-label="Timezone"
					className={cn(
						"-mr-1.5 inline-flex h-6 min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5",
						"text-[11px] tracking-tight outline-none transition-colors",
						"hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/24 data-popup-open:bg-muted/60",
					)}
				>
					<GlobeIcon className="size-3 shrink-0 text-muted-foreground/70" />
					<span className="truncate font-mono text-foreground/90">{effectiveTimezone}</span>
					<span className="shrink-0 font-mono text-muted-foreground/70">
						{formatUtcOffset(effectiveTimezone)}
					</span>
					{selectedTimezone === null && (
						<span className="shrink-0 rounded-sm border border-border/70 px-1 py-px text-[9px] font-medium uppercase tracking-[0.1em] text-muted-foreground/80">
							System
						</span>
					)}
					<ChevronDownIcon size={12} className="shrink-0 text-muted-foreground" />
				</ComboboxTrigger>
				{/* The picker popover's positioner is z-55; the combobox default of z-50 would render behind it. */}
				<ComboboxContent
					anchor={anchor}
					align="end"
					className="w-(--anchor-width)"
					positionerClassName="z-60"
					sideOffset={4}
				>
					<div className="flex items-center gap-2 border-b border-border/70 px-3">
						<GlobeIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
						<ComboboxChipsInput
							size="sm"
							placeholder="City, offset, or the time there now…"
							className="h-9 w-full ps-0 text-xs"
							// The input lives inside the popup, so focusing it on open is the
							// expected dialog behaviour, not a page-load focus grab.
							autoFocus
						/>
					</div>
					<ComboboxEmpty className="not-empty:py-6 text-xs">
						No timezone matches that.
					</ComboboxEmpty>
					<ComboboxList className="max-h-80 overflow-y-auto p-1.5">
						{(group: ZoneGroup) => (
							<ComboboxGroup
								key={group.value}
								items={group.items}
								className="[[role=group]+&]:mt-1 [[role=group]+&]:border-t [[role=group]+&]:border-border/60 [[role=group]+&]:pt-1"
							>
								<ComboboxCollection>
									{(item: string) => {
										const zone = resolveZone(item)
										const { region, city } = splitZone(zone)
										const pinned = group.value === PINNED_GROUP
										return (
											<ComboboxItem key={item} value={item} className="min-h-7 text-xs">
												<span className="flex items-center gap-3">
													<span className="min-w-0 flex-1 truncate">
														{item === SYSTEM_VALUE ? (
															<>
																<span>System</span>
																<span className="text-muted-foreground/70">
																	{" "}
																	· {zone}
																</span>
															</>
														) : pinned ? (
															<span>{zone}</span>
														) : (
															<>
																<span>{city}</span>
																<span className="text-muted-foreground/50">
																	{" "}
																	· {region}
																</span>
															</>
														)}
													</span>
													<span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground/70">
														{formatClock(zone, now)}
													</span>
													<span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground/70">
														{formatUtcOffset(zone, now)}
													</span>
												</span>
											</ComboboxItem>
										)
									}}
								</ComboboxCollection>
							</ComboboxGroup>
						)}
					</ComboboxList>
				</ComboboxContent>
			</Combobox>
		</div>
	)
}
