import type { RecommendationIssueKind, RecommendationIssueStatus } from "@maple/domain/http"
import { collectV2Pages } from "@maple/web-data/lib/v2-pagination"
import { Effect } from "effect"
import { MapleApiV2Client } from "../../platform/api-clients"

// Instrumentation recommendations, as the recommendation page and Settings > Ingestion both show
// them: the reads and the kind and status words.

const PAGE_LIMIT = 100
const page = (cursor: string | undefined) => ({
	query: cursor === undefined ? { limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, cursor },
})

/** Every page of the instrumentation recommendations. */
export const listRecommendations = Effect.flatMap(MapleApiV2Client, (client) =>
	collectV2Pages((cursor) => client.instrumentationRecommendations.list(page(cursor))),
)

/** Every page of the ingest attribute mappings. */
export const listAttributeMappings = Effect.flatMap(MapleApiV2Client, (client) =>
	collectV2Pages((cursor) => client.attributeMappings.list(page(cursor))),
)

export const RECOMMENDATION_KIND_LABEL = {
	rename: "Safe rename",
	"double-emission": "Both emitted",
	naming: "Naming",
} as const satisfies Record<RecommendationIssueKind, string>

export const RECOMMENDATION_STATUS_LABEL = {
	open: "Open",
	dismissed: "Dismissed",
	applied: "Applied",
	resolved: "Resolved",
} as const satisfies Record<RecommendationIssueStatus, string>
