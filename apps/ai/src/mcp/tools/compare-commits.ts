import { DateTime, Effect, Schema } from "effect"
import { CompareCommitsOutput } from "@maple/domain/mcp-outputs"
import { VCS_COMMIT_RANGE_COMMITS_MAX } from "@maple/domain/http"
import { CH } from "@maple/query-engine"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import { VcsCommitService } from "@maple/backend/services/integrations/vcs/VcsCommitService"
import { McpInvalidInputError, McpQueryError, type McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor, CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_DISCOVERY_MAX_HOURS } from "../lib/time"
import { truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "compare_commits"
const WINDOW = P.timeWindow({ defaultHours: 14 * 24, maxHours: MCP_DISCOVERY_MAX_HOURS })
const FULL_SHA = /^[0-9a-f]{40}$/

type Output = typeof CompareCommitsOutput.Type

/** The service's two newest versions in one environment: the given one, or the newest deploy's. */
const latestTwoVersions = (
	service: string,
	environment: string | undefined,
	startTime: string,
	endTime: string,
) =>
	withTenantExecutor(
		Effect.gen(function* () {
			const executor = yield* WarehouseExecutor
			const rows = yield* executor.compiledQuery(
				CH.compile(
					CH.serviceDeploymentsQuery({
						serviceName: service,
						environments: environment === undefined ? undefined : [environment],
						minutePrecision: false,
						limit: 100,
					}),
					{ orgId: executor.orgId, startTime, endTime },
					{ rowSchema: CH.serviceDeploymentsRowSchema },
				),
				{ profile: "aggregation", context: "compareCommitsVersions" },
			)
			const newestFirst = [...rows].sort(
				(a, b) => DateTime.toEpochMillis(b.firstSeen) - DateTime.toEpochMillis(a.firstSeen),
			)
			const env = environment ?? newestFirst[0]?.environment
			const [head, base] = newestFirst.filter((row) => row.environment === env)
			return head === undefined || base === undefined
				? undefined
				: { head: head.commitSha, base: base.commitSha, environment: head.environment }
		}),
	).pipe(Effect.catchTags(warehouseToMcpHandlers(TOOL)))

export function registerCompareCommitsTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Compare Commits",
		description:
			"The commits between two versions of a connected repository's tracked branch: what shipped in a deploy. Give `base` and `head` as full 40-character SHAs (service_deployments lists them), or give only `service` to compare its two newest deployed versions. Reads commits Maple has synced from the GitHub integration, so both ends must be on the repository's tracked branch.",
		parameters: Schema.Struct({
			service: P.service(
				"Compare this service's two newest deployed versions: its telemetry `service.name` (service_deployments lists them), not the repository name",
			),
			environment: P.environment("With `service`: the environment whose deploys to compare"),
			base: P.optionalText("The older commit, a full 40-character SHA"),
			head: P.optionalText("The newer commit, a full 40-character SHA"),
			...WINDOW.fields,
			limit: P.limit({ default: 30, max: VCS_COMMIT_RANGE_COMMITS_MAX, noun: "commits" }),
		}),
		aliases: P.SERVICE_ALIASES,
		output: CompareCommitsOutput,
		// An unknown SHA is probed against the connected repositories on GitHub.
		hints: { readOnly: true, openWorld: true },
		phrases: ["Comparing commits", "Listing what shipped"],
		handler: Effect.fn("McpTool.compareCommits")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const commits = yield* VcsCommitService

			const given = params.base !== undefined && params.head !== undefined
			if (!given && params.service === undefined) {
				return yield* new McpInvalidInputError({
					message:
						"Give `base` and `head`, or `service` to compare its two newest deployed versions.",
					parameter: "service",
					example: '{"service":"checkout"}',
				})
			}
			yield* Effect.forEach(
				[
					["base", params.base],
					["head", params.head],
				] as const,
				([name, sha]) =>
					sha === undefined || FULL_SHA.test(sha.toLowerCase())
						? Effect.void
						: Effect.fail(
								new McpInvalidInputError({
									message: `\`${name}\` must be a full 40-character commit SHA. ci_runs hands full SHAs to compare_commits in its next calls; or pass \`service\` alone to compare its two newest deployed versions.`,
									parameter: name,
								}),
							),
				{ discard: true },
			)

			const { st, et } = yield* WINDOW.resolve(params, TOOL)
			const ends = given
				? {
						base: (params.base ?? "").toLowerCase(),
						head: (params.head ?? "").toLowerCase(),
						environment: params.environment,
					}
				: yield* latestTwoVersions(params.service ?? "", params.environment, st, et)
			const where: Pick<Output, "source" | "service" | "environment"> = {
				source: given ? "given" : "service_deployments",
				...(params.service === undefined ? undefined : { service: params.service }),
				...(ends?.environment === undefined ? undefined : { environment: ends.environment }),
			}
			if (ends === undefined) {
				return {
					...where,
					base: "",
					head: "",
					status: "unavailable" as const,
					repository: "",
					totalCount: 0,
					truncated: false,
					commits: [],
					reason: `${params.service} reported fewer than two versions (vcs.ref.head.revision) in this window${params.environment ? ` in ${params.environment}` : ""}. service_deployments without a service lists every service that reports versions; the name is the telemetry service.name, not the repository.`,
				}
			}

			const toQueryError = (error: { readonly message: string }) =>
				new McpQueryError({ message: error.message, pipeName: TOOL, cause: error })
			const [range] = yield* commits
				.resolveCommitRanges(tenant.orgId, [{ base: ends.base, head: ends.head }], {
					limit: params.limit,
				})
				.pipe(Effect.mapError(toQueryError))

			const unavailableReason = Effect.fn("McpTool.compareCommits.unavailableReason")(function* () {
				// Which end Maple knows says whether the gap is a missing sync or the wrong branch.
				const known = yield* commits
					.resolveCommitDetails(tenant.orgId, [ends.base, ends.head])
					.pipe(Effect.mapError(toQueryError))
				const knows = (sha: string) => known.find((commit) => commit.sha === sha)
				const base = knows(ends.base)
				const head = knows(ends.head)
				if (base === undefined && head === undefined)
					return "Neither commit is in a connected repository; list_integrations provider=github shows which repositories sync."
				if (base === undefined || head === undefined)
					return `Only the ${base === undefined ? "head" : "base"} commit is known; the other is not on a connected repository's tracked branch.`
				if (base.repoFullName !== head.repoFullName)
					return `The commits are in different repositories (${base.repoFullName}, ${head.repoFullName}).`
				return base.committedAt > head.committedAt
					? "`base` is newer than `head`; swap them."
					: "Both commits are known but not both on the tracked branch, so the commits between them cannot be listed."
			})

			const resolved = range !== undefined && range.status === "resolved"
			return {
				...where,
				base: ends.base,
				head: ends.head,
				status: resolved ? ("resolved" as const) : ("unavailable" as const),
				repository: range?.repoFullName ?? "",
				totalCount: range?.totalCount ?? 0,
				truncated: range?.truncated ?? false,
				commits: (range?.commits ?? []).map((commit) => ({
					sha: commit.sha,
					title: commit.message.split("\n")[0] ?? "",
					author: commit.authorLogin ?? commit.authorName,
					committedAt: new Date(commit.committedAt).toISOString(),
					url: commit.htmlUrl,
				})),
				...(resolved ? undefined : { reason: yield* unavailableReason() }),
			}
		}),
		render: (output) => {
			const scope: ReadonlyArray<readonly [string, string | undefined]> = [
				["Service", output.service],
				["Environment", output.environment],
				["Base", output.base === "" ? undefined : output.base.slice(0, 12)],
				["Head", output.head === "" ? undefined : output.head.slice(0, 12)],
				["Repository", output.repository === "" ? undefined : output.repository],
			]
			if (output.status === "unavailable") {
				return {
					title: "Compare Commits",
					scope,
					empty: { message: output.reason ?? "The commit range could not be read." },
					blocks: [],
					next:
						output.service === undefined
							? []
							: [
									doc.next(
										"service_deployments",
										{ service: output.service },
										"the service's deployed versions and their SHAs",
									),
								],
				}
			}
			return {
				title: "Compare Commits",
				scope,
				blocks: [
					doc.text(
						`${output.truncated ? "At least " : ""}${output.totalCount} commit${output.totalCount === 1 ? "" : "s"} after ${output.base.slice(0, 12)} up to ${output.head.slice(0, 12)}, newest first.`,
					),
					doc.table(
						["Commit", "Committed", "Author", "Title"],
						output.commits.map((commit) => [
							commit.sha.slice(0, 12),
							commit.committedAt,
							commit.author ?? "—",
							truncate(commit.title, 120),
						]),
					),
				],
				...(output.commits.length < output.totalCount
					? {
							truncation: {
								shown: output.commits.length,
								total: output.totalCount,
								noun: "commits",
							},
						}
					: undefined),
			}
		},
	})
}
