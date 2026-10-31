import { InfraPresenceRequest, InfraPresenceResponse, type InfraSurfaceLiteral } from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { Effect, Option } from "effect"
import { AsyncData } from "foldkit"
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
	return {
		startTime: formatWarehouseDateTime(end - PRESENCE_WINDOW_MS),
		endTime: formatWarehouseDateTime(end),
	}
}

export const presenceKey = (orgId: string, window: TimeWindow) =>
	requestKey(orgId, "infraPresence", { data: { startTime: window.startTime, endTime: window.endTime } })

/** `infraPresenceResultAtom({ data: window })`: one request per org and window, shared by every reader. */
export const loadInfraPresence = (
	orgId: string,
	window: TimeWindow,
	options?: { readonly refresh?: boolean },
) =>
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

export const INTEGRATION_IDS = ["cloudflare", "railway", "planetscale", "gcp", "supabase", "aws"] as const

/** Connected integrations: `null` until its status answers; a failed status counts as not connected. */
export type IntegrationFlags = Readonly<{ [K in (typeof INTEGRATION_IDS)[number]]: boolean | null }>

export const PENDING_INTEGRATIONS: IntegrationFlags = {
	cloudflare: null,
	railway: null,
	planetscale: null,
	gcp: null,
	supabase: null,
	aws: null,
}

/**
 * Which infra surfaces an org has. `Pending` until the probe and every status answered (and no
 * remembered set stands in), so readers lay out once; `Every` when the probe failed.
 */
export type InfraSurfaces =
	| { readonly _tag: "Pending" }
	| { readonly _tag: "Every" }
	| { readonly _tag: "Only"; readonly surfaces: ReadonlySet<NavSurface> }

/** The probe's answer: its surfaces, `"failed"`, or `null` while it is in flight. */
export type PresenceProbe = ReadonlyArray<InfraSurfaceLiteral> | "failed" | null

/** A probe's slot as `resolveInfraSurfaces` reads it; a re-read keeps the last answer. */
export const probeOf = <E>(
	data: AsyncData.AsyncData<ReadonlyArray<InfraSurfaceLiteral>, E>,
): PresenceProbe => (AsyncData.isFailure(data) ? "failed" : Option.getOrNull(AsyncData.getData(data)))

/** Every integration status answered (a failed one counts as not connected). */
export const integrationsAnswered = (integrations: IntegrationFlags): boolean =>
	INTEGRATION_IDS.every((id) => integrations[id] !== null)

/** The live answer when it is complete, else the set remembered from the last visit. */
export const resolveInfraSurfaces = (
	probe: PresenceProbe,
	integrations: IntegrationFlags,
	remembered: ReadonlyArray<NavSurface> | undefined,
): InfraSurfaces => {
	const isSettled = integrationsAnswered(integrations)
	if (Array.isArray(probe) && isSettled)
		return {
			_tag: "Only",
			surfaces: new Set<NavSurface>([
				...probe,
				...INTEGRATION_IDS.filter((id) => integrations[id] === true),
			]),
		}
	if (remembered !== undefined) return { _tag: "Only", surfaces: new Set(remembered) }
	return probe === "failed" && isSettled ? { _tag: "Every" } : { _tag: "Pending" }
}

/** The live answer to remember for the next visit; `null` while it is incomplete or failed. */
export const settledSurfaces = (
	probe: PresenceProbe,
	integrations: IntegrationFlags,
): ReadonlyArray<NavSurface> | null => {
	const resolved = resolveInfraSurfaces(probe, integrations, undefined)
	return resolved._tag === "Only" ? [...resolved.surfaces].sort() : null
}
