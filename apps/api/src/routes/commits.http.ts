import {
	CommitAuthor,
	CommitInfo,
	CommitsLookupEntry,
	CommitsLookupResponse,
	CommitsResyncResponse,
	CurrentTenant,
	MapleApi,
} from "@maple/domain/http"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { GithubSyncQueue } from "../services/GithubSyncQueue"
import { GithubRepoService } from "@/services/GithubRepoService"

const parseBranches = (json: string): ReadonlyArray<string> => {
	try {
		const parsed = JSON.parse(json)
		return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []
	} catch {
		return []
	}
}

export const HttpCommitsLive = HttpApiBuilder.group(MapleApi, "commits", (handlers) =>
	Effect.gen(function* () {
		const queue = yield* GithubSyncQueue
		const githubRepo = yield* GithubRepoService

		return handlers
			.handle("commitsLookupBySha", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const commits = yield* githubRepo.findEnrichedCommitsByShas({
						orgId: tenant.orgId,
						shas: payload.shas,
					})

					const commitLookupMap = new Map(
						commits.map((row) => [
							row.sha,
							new CommitInfo({
								sha: row.sha,
								shortSha: row.shortSha,
								message: row.message,
								htmlUrl: row.htmlUrl,
								repoOwner: row.repo?.owner ?? "",
								repoName: row.repo?.name ?? "",
								author: new CommitAuthor({
									login: row.authorLogin,
									name: row.authorName,
									email: row.authorEmail,
									avatarUrl: row.authorAvatarUrl,
								}),
								committer: new CommitAuthor({
									login: row.committerLogin,
									name: row.committerName,
									email: row.committerEmail,
									avatarUrl: row.committerAvatarUrl,
								}),
								authoredAt: row.authoredAt,
								committedAt: row.committedAt,
								branches: parseBranches(row.branchesJson),
								prNumber: row.prNumber,
							}),
						]),
					)

					return new CommitsLookupResponse({
						entries: payload.shas.map(
							(sha) =>
								new CommitsLookupEntry({ sha, commit: commitLookupMap.get(sha) ?? null }),
						),
					})
				}),
			)
			.handle("commitsResync", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context

					yield* queue.enqueue({
						_tag: "ResolveUnknownSha",
						orgId: tenant.orgId,
						sha: payload.sha,
					})

					return new CommitsResyncResponse({ enqueued: true })
				}),
			)
	}),
)
