import { deriveHostStatus, severityLevel } from "../../../../components/infra/format"
import type { HostScope } from "./message"
import type { HostRow } from "./model"

export const hostPeak = (host: HostRow): number => Math.max(host.cpuPct, host.memoryPct, host.diskPct)

export const hostInScope = (host: HostRow, scope: HostScope, reference: string): boolean => {
	if (scope === "stale") return deriveHostStatus(host.lastSeen, reference) === "ended"
	const level = severityLevel(hostPeak(host))
	return scope === "saturated" ? level === "crit" : level === "warn"
}

export const countHostScopes = (hosts: ReadonlyArray<HostRow>, reference: string) => {
	const saturated = hosts.filter((host) => hostInScope(host, "saturated", reference)).length
	const elevated = hosts.filter(
		(host) => !hostInScope(host, "saturated", reference) && hostInScope(host, "elevated", reference),
	).length
	const stale = hosts.filter((host) => hostInScope(host, "stale", reference)).length
	return { total: hosts.length, saturated, elevated, stale }
}

/** `HostList`'s filter: scope, then a case-insensitive name match. */
export const filterHosts = (
	hosts: ReadonlyArray<HostRow>,
	scope: HostScope | undefined,
	query: string,
	reference: string,
): ReadonlyArray<HostRow> => {
	const q = query.trim().toLowerCase()
	return hosts.filter(
		(host) =>
			(scope === undefined || hostInScope(host, scope, reference)) &&
			(q === "" || host.hostName.toLowerCase().includes(q)),
	)
}
