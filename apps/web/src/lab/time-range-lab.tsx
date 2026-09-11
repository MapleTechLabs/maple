import { useState } from "react"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { TimeRangePicker } from "@/components/time-range-picker/time-range-picker"
import { formatUtcOffset } from "@/components/time-range-picker/timezone-select"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { PRESET_OPTIONS } from "@/lib/time-utils"
import { formatTimestampInTimezone } from "@/lib/timezone-format"

/**
 * The header time range picker with nothing behind it.
 *
 * The picker is the production one over plain component state, so every tab
 * (presets, shorthand, custom range) and the timezone selector in its footer
 * can be exercised without a session. The strip below prints the selected
 * window and a fixed instant in whatever zone is chosen, which is the only
 * way to see a timezone change do something on a page with no data.
 */
export function TimeRangeLab() {
	const [range, setRange] = useState<{ startTime?: string; endTime?: string; presetValue?: string }>(
		() => ({ ...PRESET_OPTIONS[0].getRange(), presetValue: PRESET_OPTIONS[0].value }),
	)
	const { selectedTimezone, effectiveTimezone } = useTimezonePreference()

	const rows: ReadonlyArray<{ label: string; value: string | undefined }> = [
		{ label: "Preference", value: selectedTimezone ?? "System" },
		{ label: "Effective zone", value: `${effectiveTimezone} (${formatUtcOffset(effectiveTimezone)})` },
		{ label: "Preset", value: range.presetValue ?? "—" },
		{ label: "Start (warehouse)", value: range.startTime },
		{ label: "End (warehouse)", value: range.endTime },
		{
			label: "Start (in zone)",
			value: range.startTime
				? formatTimestampInTimezone(range.startTime, { timeZone: effectiveTimezone })
				: undefined,
		},
		{
			label: "End (in zone)",
			value: range.endTime
				? formatTimestampInTimezone(range.endTime, { timeZone: effectiveTimezone })
				: undefined,
		},
		{
			label: "2026-01-01 00:00:00Z",
			value: formatTimestampInTimezone("2026-01-01T00:00:00Z", { timeZone: effectiveTimezone }),
		},
		{
			label: "2026-07-01 12:00:00Z",
			value: formatTimestampInTimezone("2026-07-01T12:00:00Z", { timeZone: effectiveTimezone }),
		},
	]

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Lab" }, { label: "Time range picker" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header
							title="Time range picker"
							description="Presets, shorthand, custom range, and the timezone selector, over local state."
						>
							<TimeRangePicker
								startTime={range.startTime}
								endTime={range.endTime}
								presetValue={range.presetValue}
								onChange={setRange}
								hotkey
							/>
						</DashboardLayout.Header>
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						<div className="mx-auto w-full max-w-2xl p-4">
							<dl className="divide-y divide-border/60 rounded-lg border border-border/70">
								{rows.map((row) => (
									<div
										key={row.label}
										className="flex items-baseline justify-between gap-6 px-3 py-2"
									>
										<dt className="text-xs text-muted-foreground">{row.label}</dt>
										<dd className="font-mono text-xs tabular-nums text-foreground/90">
											{row.value ?? "—"}
										</dd>
									</div>
								))}
							</dl>
							<p className="mt-3 text-xs text-muted-foreground">
								Press <kbd className="rounded border px-1 font-mono">D</kbd> to open the
								picker. The timezone choice is stored in localStorage and applies app-wide.
							</p>
						</div>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}
