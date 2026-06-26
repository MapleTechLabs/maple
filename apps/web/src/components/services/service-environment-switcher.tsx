import { useMemo } from "react"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { getServiceDetailOverviewResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"

/** Sentinel for the "no environment filter" option (all environments blended). */
const ALL = "all"

interface ServiceEnvironmentSwitcherProps {
	serviceName: string
	startTime?: string
	endTime?: string
	/**
	 * The active environment filter. Mirrors the Overview tab's bundle-atom input
	 * so both read the same key and share one fetch — this populates the dropdown
	 * from the bundle's `environments` field rather than its own query.
	 */
	environments?: string[]
	/** Currently-selected environment, or `undefined` for all environments. */
	value?: string
	onChange: (environment: string | undefined) => void
}

/**
 * Lets the service-detail page scope its charts to a single deployment
 * environment. Options are the environments this service actually reports in
 * the active window — sourced from the same `serviceDetailOverview` bundle the
 * Overview charts read (shared atom key ⇒ one round-trip) — plus an "All
 * environments" option.
 *
 * The selected value mirrors the service list's display labels — including the
 * synthetic `"unknown"` for spans with an empty `DeploymentEnv` — so a row's
 * environment round-trips here unchanged; the `"unknown" -> ""` remap to the raw
 * warehouse value happens server-side in `getCustomChartServiceDetail`.
 */
export function ServiceEnvironmentSwitcher({
	serviceName,
	startTime,
	endTime,
	environments,
	value,
	onChange,
}: ServiceEnvironmentSwitcherProps) {
	const overviewResult = useAtomValue(
		getServiceDetailOverviewResultAtom({
			data: { serviceName, startTime, endTime, environments },
		}),
	)

	const options = useMemo(() => {
		const set = Result.builder(overviewResult)
			.onSuccess((response) => new Set(response.environments))
			.orElse(() => new Set<string>())

		// Keep the active value selectable even before the overview loads (deep
		// link), so the trigger doesn't flash to "All environments".
		if (value) set.add(value)
		return Array.from(set).toSorted((a, b) => a.localeCompare(b))
	}, [overviewResult, value])

	const current = value ?? ALL

	return (
		<Select
			value={current}
			onValueChange={(val) => {
				if (!val) return
				onChange(val === ALL ? undefined : val)
			}}
		>
			<SelectTrigger size="sm" className="w-full sm:w-auto" aria-label="Environment">
				<SelectValue>{current === ALL ? "All environments" : current}</SelectValue>
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ALL}>All environments</SelectItem>
				{options.map((env) => (
					<SelectItem key={env} value={env}>
						{env}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}
