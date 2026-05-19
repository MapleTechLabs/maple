import {
	githubCommits,
	githubRepositories,
	type GithubCommitRow,
	type GithubRepositoryRow,
} from "@maple/db"
import {
	CommitAuthor,
	CommitInfo,
	CommitsLookupEntry,
	CommitsLookupResponse,
	CommitsResyncResponse,
	CurrentTenant,
	IntegrationsPersistenceError,
	MapleApi,
} from "@maple/domain/http"
import { and, eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Database, type DatabaseClient } from "../services/DatabaseLive"
import { GithubSyncQueue } from "../services/GithubSyncQueue"

const SHA_REGEX = /^[0-9a-f]{7,40}$/i

const toPersistenceError = (cause: unknown) =>
	new IntegrationsPersistenceError({
		message: cause instanceof Error ? cause.message : "Commits lookup database error",
	})

const parseBranches = (json: string): ReadonlyArray<string> => {
	try {
		const parsed = JSON.parse(json)
		return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []
	} catch {
		return []
	}
}

const rowToCommitInfo = (row: GithubCommitRow, repoLookup: Map<string, GithubRepositoryRow>) => {
	const repo = repoLookup.get(row.repoId)
	return new CommitInfo({
		sha: row.sha,
		shortSha: row.shortSha,
		message: row.message,
		htmlUrl: row.htmlUrl,
		repoOwner: repo?.owner ?? "",
		repoName: repo?.name ?? "",
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
	})
}

const chunk = <T>(xs: ReadonlyArray<T>, size: number): ReadonlyArray<ReadonlyArray<T>> => {
	if (xs.length <= size) return [xs]
	const out: T[][] = []
	for (let i = 0; i < xs.length; i += size) {
		out.push(xs.slice(i, i + size))
	}
	return out
}

export const HttpCommitsLive = HttpApiBuilder.group(MapleApi, "commits", (handlers) =>
	Effect.gen(function* () {
		const database = yield* Database
		const queue = yield* GithubSyncQueue

		const dbExecute = <T>(fn: (db: DatabaseClient) => Promise<T>) =>
			database.execute(fn).pipe(Effect.mapError(toPersistenceError))

		return handlers
			.handle("commitsLookupBySha", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const validShas = Array.from(
						new Set(payload.shas.filter((sha) => SHA_REGEX.test(sha))),
					)
					if (validShas.length === 0) {
						return new CommitsLookupResponse({
							entries: payload.shas.map(
								(sha) => new CommitsLookupEntry({ sha, commit: null }),
							),
						})
					}
					const commits: GithubCommitRow[] = []
					for (const batch of chunk(validShas, 50)) {
						const rows = (yield* dbExecute((db) =>
							db
								.select()
								.from(githubCommits)
								.where(
									and(
										eq(githubCommits.orgId, tenant.orgId),
										inArray(githubCommits.sha, batch as string[]),
									),
								),
						)) as ReadonlyArray<GithubCommitRow>
						commits.push(...rows)
					}
					const repoIds = Array.from(new Set(commits.map((c) => c.repoId)))
					let repoLookup = new Map<string, GithubRepositoryRow>()
					if (repoIds.length > 0) {
						const repoRows = (yield* dbExecute((db) =>
							db
								.select()
								.from(githubRepositories)
								.where(
									and(
										eq(githubRepositories.orgId, tenant.orgId),
										inArray(githubRepositories.id, repoIds),
									),
								),
						)) as ReadonlyArray<GithubRepositoryRow>
						repoLookup = new Map(repoRows.map((r) => [r.id, r]))
					}
					const byShas = new Map<string, GithubCommitRow>()
					for (const c of commits) byShas.set(c.sha, c)
					return new CommitsLookupResponse({
						entries: payload.shas.map(
							(sha) =>
								new CommitsLookupEntry({
									sha,
									commit: byShas.has(sha)
										? rowToCommitInfo(byShas.get(sha)!, repoLookup)
										: null,
								}),
						),
					})
				}),
			)
			.handle("commitsResync", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					if (!payload.sha || !SHA_REGEX.test(payload.sha)) {
						return new CommitsResyncResponse({ enqueued: false })
					}
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
