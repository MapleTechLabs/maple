import {
	GithubUpstreamError,
	GithubValidationError,
} from "@maple/domain/http"
import { Context, Effect, Layer, Schema } from "effect"
import { GithubAppJwtService } from "./GithubAppJwtService"

const USER_AGENT = "maple-github-app"

const GithubUserSchema = Schema.Struct({
	login: Schema.String,
	id: Schema.Number,
	avatar_url: Schema.optional(Schema.String),
	type: Schema.optional(Schema.String),
})

const GithubRepoSchema = Schema.Struct({
	id: Schema.Number,
	name: Schema.String,
	full_name: Schema.String,
	owner: GithubUserSchema,
	private: Schema.Boolean,
	html_url: Schema.String,
	default_branch: Schema.String,
})
export type GithubRepo = Schema.Schema.Type<typeof GithubRepoSchema>

const InstallationRepoListSchema = Schema.Struct({
	total_count: Schema.Number,
	repositories: Schema.Array(GithubRepoSchema),
})

const GithubCommitAuthorSchema = Schema.Struct({
	name: Schema.optional(Schema.String),
	email: Schema.optional(Schema.String),
	date: Schema.optional(Schema.String),
})

const GithubCommitDetailSchema = Schema.Struct({
	sha: Schema.String,
	html_url: Schema.String,
	commit: Schema.Struct({
		message: Schema.String,
		author: Schema.optional(GithubCommitAuthorSchema),
		committer: Schema.optional(GithubCommitAuthorSchema),
	}),
	author: Schema.NullOr(GithubUserSchema),
	committer: Schema.NullOr(GithubUserSchema),
})
export type GithubCommit = Schema.Schema.Type<typeof GithubCommitDetailSchema>

const GithubBranchSchema = Schema.Struct({
	name: Schema.String,
	commit: Schema.Struct({ sha: Schema.String }),
})

const GithubInstallationSchema = Schema.Struct({
	id: Schema.Number,
	account: Schema.Struct({
		id: Schema.Number,
		login: Schema.String,
		type: Schema.String,
		avatar_url: Schema.optional(Schema.String),
	}),
	app_slug: Schema.String,
	target_type: Schema.String,
	repository_selection: Schema.String,
	permissions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
	events: Schema.optional(Schema.Array(Schema.String)),
	suspended_at: Schema.NullOr(Schema.String),
})
export type GithubInstallation = Schema.Schema.Type<typeof GithubInstallationSchema>

// /search/commits response items include the source repository inline.
const SearchCommitItemSchema = Schema.Struct({
	sha: Schema.String,
	html_url: Schema.String,
	commit: Schema.Struct({
		message: Schema.String,
		author: Schema.optional(GithubCommitAuthorSchema),
		committer: Schema.optional(GithubCommitAuthorSchema),
	}),
	author: Schema.NullOr(GithubUserSchema),
	committer: Schema.NullOr(GithubUserSchema),
	repository: Schema.Struct({
		id: Schema.Number,
		name: Schema.String,
		full_name: Schema.String,
		owner: Schema.Struct({ login: Schema.String }),
	}),
})
const SearchCommitsResponseSchema = Schema.Struct({
	total_count: Schema.Number,
	items: Schema.Array(SearchCommitItemSchema),
})
export type SearchCommitResult = Schema.Schema.Type<typeof SearchCommitItemSchema>

const decodeInstallationRepos = Schema.decodeUnknownEffect(InstallationRepoListSchema)
const decodeCommit = Schema.decodeUnknownEffect(GithubCommitDetailSchema)
const decodeCommits = Schema.decodeUnknownEffect(Schema.Array(GithubCommitDetailSchema))
const decodeBranches = Schema.decodeUnknownEffect(Schema.Array(GithubBranchSchema))
const decodeInstallation = Schema.decodeUnknownEffect(GithubInstallationSchema)
const decodeSearchCommits = Schema.decodeUnknownEffect(SearchCommitsResponseSchema)

const toUpstreamError = (message: string, status?: number) =>
	new GithubUpstreamError({ message, ...(status === undefined ? {} : { status }) })

const parseNextLink = (linkHeader: string | null): string | null => {
	if (!linkHeader) return null
	for (const part of linkHeader.split(",")) {
		const match = /<([^>]+)>;\s*rel="next"/.exec(part)
		if (match) return match[1] ?? null
	}
	return null
}

/** Fail with a formatted upstream error including response body text. */
const expectOk = (response: Response, label: string) =>
	Effect.gen(function* () {
		if (response.ok) return
		const text = yield* Effect.tryPromise({
			try: () => response.text(),
			catch: () => toUpstreamError(`${label} failed`, response.status),
		})
		return yield* Effect.fail(
			toUpstreamError(`${label} failed (${response.status}): ${text || response.statusText}`, response.status),
		)
	})

/** Read the response as JSON and decode it with the given schema. */
const parseJson = <A>(
	response: Response,
	decoder: (u: unknown) => Effect.Effect<A, unknown>,
	label: string,
) =>
	Effect.gen(function* () {
		const json = yield* Effect.tryPromise({
			try: () => response.json(),
			catch: () => toUpstreamError(`${label} returned non-JSON`),
		})
		return yield* decoder(json).pipe(
			Effect.mapError(() => toUpstreamError(`${label} returned unexpected payload`)),
		)
	})

export interface CommitPage {
	readonly commits: ReadonlyArray<GithubCommit>
	readonly nextCursor: string | null
}

export interface GithubInstallationClientShape {
	readonly listInstallationRepositories: (
		installationId: number,
	) => Effect.Effect<
		ReadonlyArray<GithubRepo>,
		GithubValidationError | GithubUpstreamError
	>
	readonly listCommitsPaginated: (
		installationId: number,
		options: {
			readonly owner: string
			readonly name: string
			readonly sha?: string | null
			readonly since?: string | null
			readonly cursor?: string | null
			readonly perPage?: number
		},
	) => Effect.Effect<CommitPage, GithubValidationError | GithubUpstreamError>
	readonly getCommit: (
		installationId: number,
		owner: string,
		name: string,
		sha: string,
	) => Effect.Effect<
		GithubCommit | null,
		GithubValidationError | GithubUpstreamError
	>
	readonly listBranchesForCommit: (
		installationId: number,
		owner: string,
		name: string,
		sha: string,
	) => Effect.Effect<
		ReadonlyArray<string>,
		GithubValidationError | GithubUpstreamError
	>
	readonly compareRefs: (
		installationId: number,
		owner: string,
		name: string,
		base: string,
		head: string,
	) => Effect.Effect<
		ReadonlyArray<GithubCommit>,
		GithubValidationError | GithubUpstreamError
	>
	readonly getInstallationMetadata: (
		installationId: number,
	) => Effect.Effect<
		GithubInstallation,
		GithubValidationError | GithubUpstreamError
	>
	/**
	 * Search the installation's accessible repos for a commit by SHA. Single
	 * API call regardless of how many repos the installation grants — much
	 * cheaper than iterating repos and calling getCommit on each. Returns the
	 * first match (search results are ordered best-match first), or null.
	 *
	 * Note: GitHub's commit search indexer can lag by minutes for very fresh
	 * commits. We accept that — the chip will re-query on the next hover.
	 */
	readonly searchCommitBySha: (
		installationId: number,
		sha: string,
	) => Effect.Effect<
		SearchCommitResult | null,
		GithubValidationError | GithubUpstreamError
	>
}

export class GithubInstallationClient extends Context.Service<
	GithubInstallationClient,
	GithubInstallationClientShape
>()("GithubInstallationClient", {
	make: Effect.gen(function* () {
		const jwtService = yield* GithubAppJwtService

		const authedFetch = (installationId: number, url: string, init?: RequestInit) =>
			Effect.gen(function* () {
				const config = yield* jwtService.resolveConfig
				const { token } = yield* jwtService.getInstallationToken(installationId)
				const fullUrl = url.startsWith("http") ? url : `${config.apiBaseUrl}${url}`
				const response = yield* Effect.tryPromise({
					try: () =>
						fetch(fullUrl, {
							...init,
							headers: {
								authorization: `Bearer ${token}`,
								accept: "application/vnd.github+json",
								"x-github-api-version": "2022-11-28",
								"user-agent": USER_AGENT,
								...(init?.headers ?? {}),
							},
						}),
					catch: (cause) =>
						toUpstreamError(
							cause instanceof Error
								? `GitHub request failed: ${cause.message}`
								: "GitHub request failed",
						),
				})
				if (response.status === 401 || response.status === 403) {
					yield* jwtService.invalidateInstallationToken(installationId)
				}
				return response
			})

		const repoPath = (owner: string, name: string) =>
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`

		const listInstallationRepositories = Effect.fn(
			"GithubInstallationClient.listInstallationRepositories",
		)(function* (installationId: number) {
			const repos: GithubRepo[] = []
			let nextUrl: string | null = "/installation/repositories?per_page=100"
			while (nextUrl) {
				const response: Response = yield* authedFetch(installationId, nextUrl)
				yield* expectOk(response, "listInstallationRepositories")
				const page = yield* parseJson(
					response,
					decodeInstallationRepos,
					"listInstallationRepositories",
				)
				repos.push(...page.repositories)
				nextUrl = parseNextLink(response.headers.get("link"))
			}
			return repos as ReadonlyArray<GithubRepo>
		})

		const listCommitsPaginated = Effect.fn(
			"GithubInstallationClient.listCommitsPaginated",
		)(function* (
			installationId: number,
			options: {
				readonly owner: string
				readonly name: string
				readonly sha?: string | null
				readonly since?: string | null
				readonly cursor?: string | null
				readonly perPage?: number
			},
		) {
			let url: string
			if (options.cursor) {
				url = options.cursor
			} else {
				const params = new URLSearchParams()
				params.set("per_page", String(options.perPage ?? 100))
				if (options.sha) params.set("sha", options.sha)
				if (options.since) params.set("since", options.since)
				url = `${repoPath(options.owner, options.name)}/commits?${params.toString()}`
			}
			const response: Response = yield* authedFetch(installationId, url)
			// 409 = empty repository (no commits at all).
			if (response.status === 409) return { commits: [], nextCursor: null } satisfies CommitPage
			yield* expectOk(response, "listCommitsPaginated")
			const commits = yield* parseJson(response, decodeCommits, "listCommitsPaginated")
			return {
				commits,
				nextCursor: parseNextLink(response.headers.get("link")),
			} satisfies CommitPage
		})

		const getCommit = Effect.fn("GithubInstallationClient.getCommit")(function* (
			installationId: number,
			owner: string,
			name: string,
			sha: string,
		) {
			const response: Response = yield* authedFetch(
				installationId,
				`${repoPath(owner, name)}/commits/${encodeURIComponent(sha)}`,
			)
			// 404 = sha not in this repo; 422 = malformed sha. Neither is an error.
			if (response.status === 404 || response.status === 422) return null
			yield* expectOk(response, "getCommit")
			return yield* parseJson(response, decodeCommit, "getCommit")
		})

		const listBranchesForCommit = Effect.fn(
			"GithubInstallationClient.listBranchesForCommit",
		)(function* (installationId: number, owner: string, name: string, sha: string) {
			const response: Response = yield* authedFetch(
				installationId,
				`${repoPath(owner, name)}/commits/${encodeURIComponent(sha)}/branches-where-head`,
			)
			// Best-effort: missing data is fine, never fail the caller.
			if (!response.ok) return [] as ReadonlyArray<string>
			const branches = yield* parseJson(response, decodeBranches, "listBranchesForCommit")
			return branches.map((b) => b.name) as ReadonlyArray<string>
		})

		const compareRefs = Effect.fn("GithubInstallationClient.compareRefs")(function* (
			installationId: number,
			owner: string,
			name: string,
			base: string,
			head: string,
		) {
			const response: Response = yield* authedFetch(
				installationId,
				`${repoPath(owner, name)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
			)
			// Best-effort fallback used when push.commits is empty; never fail the caller.
			if (!response.ok) return [] as ReadonlyArray<GithubCommit>
			const json = yield* Effect.tryPromise({
				try: () => response.json() as Promise<{ commits?: unknown }>,
				catch: () => toUpstreamError("compareRefs returned non-JSON"),
			})
			const decoded = yield* decodeCommits(json.commits ?? []).pipe(
				Effect.mapError(() => toUpstreamError("compareRefs returned unexpected payload")),
			)
			return decoded as ReadonlyArray<GithubCommit>
		})

		// Uses the App-level JWT (not the installation token) so it works even
		// before we've stored the installation row in our DB — see the install
		// callback flow.
		const getInstallationMetadata = Effect.fn(
			"GithubInstallationClient.getInstallationMetadata",
		)(function* (installationId: number) {
			const config = yield* jwtService.resolveConfig
			const jwt = yield* jwtService.mintAppJwt
			const response = yield* Effect.tryPromise({
				try: () =>
					fetch(`${config.apiBaseUrl}/app/installations/${installationId}`, {
						headers: {
							authorization: `Bearer ${jwt}`,
							accept: "application/vnd.github+json",
							"x-github-api-version": "2022-11-28",
							"user-agent": USER_AGENT,
						},
					}),
				catch: (cause) =>
					toUpstreamError(
						cause instanceof Error
							? `getInstallationMetadata failed: ${cause.message}`
							: "getInstallationMetadata failed",
					),
			})
			yield* expectOk(response, "getInstallationMetadata")
			return yield* parseJson(response, decodeInstallation, "getInstallationMetadata")
		})

		const searchCommitBySha = Effect.fn("GithubInstallationClient.searchCommitBySha")(
			function* (installationId: number, sha: string) {
				const params = new URLSearchParams()
				params.set("q", `hash:${sha}`)
				params.set("per_page", "1")
				const response: Response = yield* authedFetch(
					installationId,
					`/search/commits?${params.toString()}`,
				)
				// Search API rate limit / token scope issues both surface as 4xx;
				// treat them as "not found" rather than failing the caller.
				if (response.status === 403 || response.status === 422) return null
				// 304 Not Modified can also appear if we were to send ETags.
				if (!response.ok) return null
				const decoded = yield* parseJson(response, decodeSearchCommits, "searchCommitBySha")
				return (decoded.items[0] ?? null) as SearchCommitResult | null
			},
		)

		return {
			listInstallationRepositories,
			listCommitsPaginated,
			getCommit,
			listBranchesForCommit,
			compareRefs,
			getInstallationMetadata,
			searchCommitBySha,
		} satisfies GithubInstallationClientShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(GithubAppJwtService.layer),
	)
	static readonly Default = this.layer
}
