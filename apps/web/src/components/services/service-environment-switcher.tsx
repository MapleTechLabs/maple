import { useMemo } from "react"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { getServiceOverviewResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"

/** Sentinel for the "no environment filter" option (all environments blended). */
const ALL = "all"

interface ServiceEnvironmentSwitcherProps {
	serviceName: string
	startTime?: string
	endTime?: string
	/** Currently-selected environment, or `undefined` for all environments. */
	value?: string
	onChange: (environment: string | undefined) => void
}

/**
 * Lets the service-detail page scope its charts to a single deployment
 * environment. Options are the environments this service actually reports in
 * the active window (sourced from the shared, app-wide-cached service overview
 * atom) plus an "All environments" option.
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
	value,
	onChange,
}: ServiceEnvironmentSwitcherProps) {
	const overviewResult = useAtomValue(getServiceOverviewResultAtom({ data: { startTime, endTime } }))

	const options = useMemo(() => {
		const set = Result.builder(overviewResult)
			.onSuccess((response) => {
				const envs = new Set<string>()
				for (const service of response.data) {
					if (service.serviceName === serviceName && service.environment) {
						envs.add(service.environment)
					}
				}
				return envs
			})
			.orElse(() => new Set<string>())

		// Keep the active value selectable even before the overview loads (deep
		// link), so the trigger doesn't flash to "All environments".
		if (value) set.add(value)
		return Array.from(set).toSorted((a, b) => a.localeCompare(b))
	}, [overviewResult, serviceName, value])

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
