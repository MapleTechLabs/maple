import { Effect, Schema, Array as Arr, String as Str } from "effect"
import { CompareCommitsOutput } from "@maple/domain/mcp-outputs"
import { VCS_COMMIT_RANGE_COMMITS_MAX } from "@maple/domain/http"
import { VcsCommitService } from "@maple/backend/services/integrations/vcs/VcsCommitService"
import { McpInvalidInputError, McpQueryError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { serviceDeploysNewestFirst } from "../lib/deploys"
import { MCP_DISCOVERY_MAX_HOURS } from "../lib/time"
import { truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "compare_commits"
const WINDOW = P.timeWindow({ defaultHours: 14 * 24, maxHours: MCP_DISCOVERY_MAX_HOURS })
const FULL_SHA = /^[0-9a-f]{40}$/

type Output = typeof CompareCommitsOutput.Type

/** GitHub's compare view for two SHAs, from a commit's GitHub URL; undefined for another host. */
const githubCompareUrl = (commitUrl: string, base: string, head: string): string | undefined => {
	const match = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/commit\/[0-9a-f]{40}$/.exec(commitUrl)
	return match?.[1] === undefined ? undefined : `${match[1]}/compare/${base}...${head}`
}

/** The service's two newest versions in one environment: the given one, or the newest deploy's. */
const latestTwoVersions = (
	service: string,
	environment: string | undefined,
	startTime: string,
	endTime: string,
) =>
	Effect.map(
		serviceDeploysNewestFirst(TOOL, "compareCommitsVersions", service, environment, startTime, endTime),
		(newestFirst) => {
			const env = environment ?? newestFirst[0]?.environment
			const [head, base] = Arr.filter(newestFirst, (row) => row.environment === env)
			return head === undefined || base === undefined
				? undefined
				: { head: head.commitSha, base: base.commitSha, environment: head.environment }
		},
	)

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
		// Maple's own agents only: the org's commit history is not for third-party MCP clients.
		audience: "agent",
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
					sha === undefined || FULL_SHA.test(Str.toLowerCase(sha))
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
						base: Str.toLowerCase(params.base ?? ""),
						head: Str.toLowerCase(params.head ?? ""),
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

			const unavailable = Effect.fn("McpTool.compareCommits.unavailable")(function* () {
				// Which end Maple knows says whether the gap is a missing sync or the wrong branch.
				const known = yield* commits
					.resolveCommitDetails(tenant.orgId, [ends.base, ends.head])
					.pipe(Effect.mapError(toQueryError))
				const knows = (sha: string) => known.find((commit) => commit.sha === sha)
				const base = knows(ends.base)
				const head = knows(ends.head)
				const repository = head?.repoFullName || base?.repoFullName || undefined
				const found = { ...(repository === undefined ? undefined : { repository }) }
				if (base === undefined || head === undefined) {
					return {
						...found,
						reason:
							base === undefined && head === undefined
								? "Neither commit is in a connected repository; list_integrations provider=github shows which repositories sync."
								: `Only the ${base === undefined ? "head" : "base"} commit is known${repository === undefined ? "" : ` (in ${repository})`}; the other is in no connected repository.`,
					}
				}
				if (base.repoFullName !== head.repoFullName)
					return {
						...found,
						reason: `The commits are in different repositories (base in ${base.repoFullName}, head in ${head.repoFullName}).`,
					}
				if (base.committedAt > head.committedAt)
					return { ...found, reason: "`base` is newer than `head`; swap them." }
				// A SHA read from GitHub on demand is not on the branch Maple syncs, so the history
				// between the two is not stored; GitHub's own compare view still lists it.
				const offBranch = Arr.filter(
					[
						["base", base],
						["head", head],
					] as const,
					([, commit]) => commit.resolved === "fetched",
				)
				const compareUrl = githubCompareUrl(head.htmlUrl, ends.base, ends.head)
				const which =
					offBranch.length === 0
						? "One of the commits is not on the branch Maple syncs"
						: `The ${Arr.join(
								Arr.map(
									offBranch,
									([name, commit]) => `${name} (${Str.slice(0, 12)(commit.sha)})`,
								),
								" and ",
							)} ${offBranch.length === 1 ? "is" : "are"} not on ${repository}'s tracked branch (deployed from another branch, or pushed after the last sync)`
				return {
					...found,
					...(compareUrl === undefined ? undefined : { compareUrl }),
					reason: `${which}, so Maple cannot list the commits between them.${compareUrl === undefined ? "" : ` GitHub compares them at ${compareUrl}.`}`,
				}
			})

			const resolved = range !== undefined && range.status === "resolved"
			const missing = resolved ? undefined : yield* unavailable()
			const repository = resolved ? range.repoFullName : missing?.repository
			return {
				...where,
				base: ends.base,
				head: ends.head,
				status: resolved ? ("resolved" as const) : ("unavailable" as const),
				...(repository === undefined || repository === "" ? undefined : { repository }),
				totalCount: range?.totalCount ?? 0,
				truncated: range?.truncated ?? false,
				commits: Arr.map(range?.commits ?? [], (commit) => ({
					sha: commit.sha,
					title: Str.split("\n")(commit.message)[0] ?? "",
					author: commit.authorLogin ?? commit.authorName,
					committedAt: new Date(commit.committedAt).toISOString(),
					url: commit.htmlUrl,
				})),
				...(missing === undefined
					? undefined
					: {
							reason: missing.reason,
							...(missing.compareUrl === undefined
								? undefined
								: { compareUrl: missing.compareUrl }),
						}),
			}
		}),
		render: (output) => {
			const scope: ReadonlyArray<readonly [string, string | undefined]> = [
				["Service", output.service],
				["Environment", output.environment],
				["Base", output.base === "" ? undefined : Str.slice(0, 12)(output.base)],
				["Head", output.head === "" ? undefined : Str.slice(0, 12)(output.head)],
				["Repository", output.repository],
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
						`${output.truncated ? "At least " : ""}${output.totalCount} commit${output.totalCount === 1 ? "" : "s"} after ${Str.slice(0, 12)(output.base)} up to ${Str.slice(0, 12)(output.head)}, newest first.`,
					),
					doc.table(
						["Commit", "Committed", "Author", "Title"],
						Arr.map(output.commits, (commit) => [
							Str.slice(0, 12)(commit.sha),
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
