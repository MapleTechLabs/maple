import { V2AnomalyServiceCount } from "@maple/domain/http/v2"
import { Effect, Schema } from "effect"
import { MapleApiV2Client } from "../platform/api-clients"
import { IdleTtl } from "./idle-ttl"
import { ReadCache } from "./read-cache"
import type { RequestKey } from "./request-key"

/**
 * `openAnomalyServiceCountsAtom`, which the Overview and the services list both read: through the
 * read cache, so the second page is answered without a request; a Reload reads again.
 */
export const loadAnomalyServiceCounts = (key: RequestKey, options?: { readonly refresh?: boolean }) =>
	Effect.gen(function* () {
		const cache = yield* ReadCache
		const client = yield* MapleApiV2Client
		return yield* cache.read(
			{
				key,
				idleTtlMs: IdleTtl.retainedQuery,
				schema: Schema.Array(V2AnomalyServiceCount),
				refresh: options?.refresh === true,
			},
			Effect.map(
				client.anomalies.serviceCounts({ query: { status: "open" } }),
				(response) => response.data,
			),
		)
	})
