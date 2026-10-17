import { Effect, Option } from "effect"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { acmeGithubEndpoints } from "../../datasets/acme-github.ts"
import type { EndpointHandler } from "../../dataset.ts"
import { DAY, FROZEN_NOW_MS, fixtureUuid, HOUR } from "../../identity.ts"
import { iso, list, str } from "./synthetic.ts"

/** Postgres-backed reads with no warehouse side: canned in wire form. */

/** Triage on, well inside today's budget. */
const aiTriageSettings: EndpointHandler = () =>
	Effect.succeed({
		enabled: true,
		maxRunsPerDay: 50,
		maxPassesPerDay: 300,
		usage: { runs: 2, passes: 9 },
		ordinaryPaused: false,
		priorityPaused: false,
		pausedDimension: null,
		resumesAt: null,
		updatedAt: iso(FROZEN_NOW_MS - 6 * DAY),
		updatedBy: null,
	})

/** Every `base..head` range resolves to its head commit, the release the swimlane names. */
const vcsCommitRanges: EndpointHandler = (request) =>
	Effect.gen(function* () {
		const detail = acmeGithubEndpoints["integrations.vcsCommitDetail"]
		const ranges = (str(request.query, "ranges") ?? "").split(",").filter((range) => range.includes(".."))
		return {
			ranges: yield* Effect.forEach(ranges, (range) =>
				Effect.gen(function* () {
					const [base = "", head = ""] = range.split("..")
					const commit =
						detail === undefined
							? Option.none()
							: yield* Effect.option(detail({ ...request, params: { sha: head } }))
					const commits = Option.isSome(commit) ? [commit.value] : []
					return {
						base,
						head,
						status: commits.length === 0 ? "unavailable" : "resolved",
						repoFullName: "acme-shop/shop",
						totalCount: commits.length,
						commits,
						truncated: false,
					}
				}),
			),
		}
	})

const recommendation = (
	index: number,
	kind: "rename" | "double-emission",
	source: string,
	canonical: string,
	usage: number,
	openedDaysAgo: number,
) => ({
	id: encodePublicId(PublicIdPrefixes.recommendation, fixtureUuid(0x62, index)),
	object: "recommendation",
	number: index,
	recommendation_key: `${kind}:${source}`,
	kind,
	source_key: source,
	canonical_key: canonical,
	status: "open",
	usage_count: usage,
	opened_at: iso(FROZEN_NOW_MS - openedDaysAgo * DAY),
	updated_at: iso(FROZEN_NOW_MS - 3 * HOUR),
	resolved_at: null,
})

/** What the reconciler finds in Acme's spans: two double-emitted keys and a deprecated one. */
export const RECOMMENDATIONS = [
	recommendation(
		1,
		"double-emission",
		"deployment.environment",
		"deployment.environment.name",
		412_880,
		12,
	),
	recommendation(2, "double-emission", "db.system", "db.system.name", 96_314, 12),
	recommendation(3, "rename", "peer.service", "service.peer.name", 41_027, 5),
]

export const miscEndpoints = {
	"aiTriage.getSettings": aiTriageSettings,
	"integrations.vcsCommitRanges": vcsCommitRanges,
} satisfies Readonly<Record<string, EndpointHandler>>

export const miscDatasetEndpoints = {
	"instrumentationRecommendations.list": ({ query }) => {
		const status = str(query, "status")
		return Effect.succeed(
			list(RECOMMENDATIONS.filter((row) => status === undefined || row.status === status)),
		)
	},
} satisfies Readonly<Record<string, EndpointHandler>>
