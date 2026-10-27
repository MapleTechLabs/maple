import { isMapleService } from "@maple/domain/uptime"
import { Schema } from "effect"
import type { UptimeMonitor } from "../shared/uptime-derive"

// The Uptime tab's namespace groups. A monitor stores only its service's name, so its namespace is
// the one that service reported telemetry under.

/** Service name to the namespace it reported under; `""` for none. */
export const ServiceNamespaces = Schema.Record(Schema.String, Schema.String)
export type ServiceNamespaces = typeof ServiceNamespaces.Type

/** Sentinel group key for monitors with no service or a service without a namespace; sorted last. */
export const NO_NAMESPACE = ""

type OverviewRow = Readonly<{ serviceName: string; serviceNamespace: string; spanCount: number }>

/**
 * Each service's namespace from the service overview rows (one per service, namespace and
 * environment). A name reported under several namespaces takes the one with the most spans.
 */
export const serviceNamespaces = (rows: ReadonlyArray<OverviewRow>): ServiceNamespaces => {
	const spans = rows
		.filter((row) => !isMapleService(row))
		.reduce((acc, row) => {
			const key = `${row.serviceName}\u0000${row.serviceNamespace}`
			return acc.set(key, {
				service: row.serviceName,
				namespace: row.serviceNamespace,
				spans: (acc.get(key)?.spans ?? 0) + row.spanCount,
			})
		}, new Map<string, { service: string; namespace: string; spans: number }>())
	const busiest = [...spans.values()].reduce((acc, entry) => {
		const current = acc.get(entry.service)
		return current === undefined || entry.spans > current.spans ? acc.set(entry.service, entry) : acc
	}, new Map<string, { namespace: string; spans: number }>())
	return Object.fromEntries([...busiest].map(([service, entry]) => [service, entry.namespace]))
}

export const monitorNamespace = (monitor: UptimeMonitor, namespaces: ServiceNamespaces): string =>
	monitor.service_name === null ? NO_NAMESPACE : (namespaces[monitor.service_name] ?? NO_NAMESPACE)

export type MonitorGroup = readonly [namespace: string, monitors: ReadonlyArray<UptimeMonitor>]

/**
 * Grouped by namespace once any monitor resolves to one, named groups A to Z and "No namespace"
 * last; one unnamed group otherwise. The list's own order holds inside each group.
 */
export const groupMonitors = (
	monitors: ReadonlyArray<UptimeMonitor>,
	namespaces: ServiceNamespaces,
): ReadonlyArray<MonitorGroup> => {
	const groups = monitors.reduce((acc, monitor) => {
		const namespace = monitorNamespace(monitor, namespaces)
		return acc.set(namespace, [...(acc.get(namespace) ?? []), monitor])
	}, new Map<string, ReadonlyArray<UptimeMonitor>>())
	if (![...groups.keys()].some((namespace) => namespace !== NO_NAMESPACE)) return [[NO_NAMESPACE, monitors]]
	return [...groups].toSorted(([a], [b]) =>
		a === NO_NAMESPACE ? 1 : b === NO_NAMESPACE ? -1 : a.localeCompare(b),
	)
}
