import { createContext, use, useMemo, type ReactNode } from "react"

import { formatWarehouseDateTime } from "@maple/query-engine"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { getServicesFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { snapRangeForCache } from "@/lib/time-utils"

const EMPTY: ReadonlySet<string> = new Set()

const KnownServicesContext = createContext<ReadonlySet<string>>(EMPTY)

/**
 * The service names the org actually reports, so a chat table can link the ones
 * it names and leave the rest as text.
 *
 * This is the same snapped 24h facets probe the overview, service map and
 * namespace switcher run, so a chat panel shares their cache entry instead of
 * adding a warehouse request of its own. Before it resolves the set is empty and
 * service cells render as plain text, which is the correct degraded state: a
 * link that may 404 is worse than no link.
 */
export function KnownServicesProvider({ children }: { children: ReactNode }) {
	const range = useMemo(() => {
		const end = Date.now()
		return snapRangeForCache({
			startTime: formatWarehouseDateTime(end - 24 * 60 * 60 * 1000),
			endTime: formatWarehouseDateTime(end),
		})
	}, [])

	const facets = useAtomValue(getServicesFacetsResultAtom({ data: range }))
	const services = useMemo(() => {
		if (!Result.isSuccess(facets)) return EMPTY
		return new Set(
			facets.value.data.services.map((service) => service.name).filter((name) => name !== ""),
		)
	}, [facets])

	return <ProvideKnownServices services={services}>{children}</ProvideKnownServices>
}

/** The context alone, for surfaces that already know their services (and for tests). */
export function ProvideKnownServices({
	services,
	children,
}: {
	services: ReadonlySet<string>
	children: ReactNode
}) {
	return <KnownServicesContext value={services}>{children}</KnownServicesContext>
}

export function useKnownServices(): ReadonlySet<string> {
	return use(KnownServicesContext)
}
