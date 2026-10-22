import { InfraPresenceRequest, InfraPresenceResponse, type InfraSurfaceLiteral } from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { Effect } from "effect"
import { MapleInternalApiClient } from "../platform/api-clients"
import type { NavSurface } from "../shell/nav"
import { readThrough } from "./read-cache"
import { requestKey } from "./request-key"
import type { TimeWindow } from "./time-range"

// The infra surfaces: the presence probe plus the four
// integration statuses. The shell and the pages read the probe through one cache entry per window.

/** The last hour, snapped to five minutes so the key holds still. */
const PRESENCE_WINDOW_MS = 60 * 60 * 1000
const PRESENCE_BUCKET_MS = 5 * 60 * 1000

/** `infraPresenceResultAtom`'s `staleTime`. */
const PRESENCE_IDLE_TTL_MS = 300_000

/** The window `useInfraSurfaces()` probes when it is given none. */
export const lastHourWindow = (nowMs: number): TimeWindow => {
	const end = Math.floor(nowMs / PRESENCE_BUCKET_MS) * PRESENCE_BUCKET_MS
	return { startTime: formatWarehouseDateTime(end - PRESENCE_WINDOW_MS), endTime: formatWarehouseDateTime(end) }
}

export const presenceKey = (orgId: string, window: TimeWindow) =>
	requestKey(orgId, "infraPresence", { data: { startTime: window.startTime, endTime: window.endTime } })

/** `infraPresenceResultAtom({ data: window })`: one request per org and window, shared by every reader. */
export const loadInfraPresence = (orgId: string, window: TimeWindow, options?: { readonly refresh?: boolean }) =>
	readThrough(
		{
			key: presenceKey(orgId, window),
			idleTtlMs: PRESENCE_IDLE_TTL_MS,
			schema: InfraPresenceResponse,
			refresh: options?.refresh === true,
		},
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return yield* client.queryEngine.infraPresence({
				payload: new InfraPresenceRequest({ startTime: window.startTime, endTime: window.endTime }),
			})
		}),
	).pipe(Effect.map((response) => response.surfaces))

/** Connected integrations; one that has not answered (or failed) counts as not connected. */
export interface IntegrationFlags {
	readonly cloudflare: boolean
	readonly railway: boolean
	readonly planetscale: boolean
	readonly gcp: boolean
	readonly supabase: boolean
}

/** The probe's surfaces plus the connected integrations; `null` while the probe is unknown. */
export const infraSurfacesOf = (
	presence: ReadonlyArray<InfraSurfaceLiteral> | null,
	integrations: IntegrationFlags,
): ReadonlySet<NavSurface> | null => {
	if (presence === null) return null
	const connected = (["cloudflare", "planetscale", "railway", "gcp", "supabase"] as const).filter((id) => integrations[id])
	return new Set<NavSurface>([...presence, ...connected])
}
