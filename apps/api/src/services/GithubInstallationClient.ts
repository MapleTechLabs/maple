import {
	IntegrationsUpstreamError,
	IntegrationsValidationError,
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

const decodeInstallationRepos = Schema.decodeUnknownEffect(InstallationRepoListSchema)
const decodeCommit = Schema.decodeUnknownEffect(GithubCommitDetailSchema)
const decodeCommits = Schema.decodeUnknownEffect(Schema.Array(GithubCommitDetailSchema))
const decodeBranches = Schema.decodeUnknownEffect(Schema.Array(GithubBranchSchema))
const decodeInstallation = Schema.decodeUnknownEffect(GithubInstallationSchema)

const toUpstreamError = (message: string, status?: number) =>
	new IntegrationsUpstreamError({ message, ...(status === undefined ? {} : { status }) })

const parseNextLink = (linkHeader: string | null): string | null => {
	if (!linkHeader) return null
	const parts = linkHeader.split(",")
	for (const part of parts) {
		const match = /<([^>]+)>;\s*rel="next"/.exec(part)
		if (match) return match[1] ?? null
	}
	return null
}

export interface CommitPage {
	readonly commits: ReadonlyArray<GithubCommit>
	readonly nextCursor: string | null
}

export interface GithubInstallationClientShape {
	readonly listInstallationRepositories: (
		installationId: number,
	) => Effect.Effect<
		ReadonlyArray<GithubRepo>,
		IntegrationsValidationError | IntegrationsUpstreamError
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
	) => Effect.Effect<CommitPage, IntegrationsValidationError | IntegrationsUpstreamError>
	readonly getCommit: (
		installationId: number,
		owner: string,
		name: string,
		sha: string,
	) => Effect.Effect<
		GithubCommit | null,
		IntegrationsValidationError | IntegrationsUpstreamError
	>
	readonly listBranchesForCommit: (
		installationId: number,
		owner: string,
		name: string,
		sha: string,
	) => Effect.Effect<
		ReadonlyArray<string>,
		IntegrationsValidationError | IntegrationsUpstreamError
	>
	readonly compareRefs: (
		installationId: number,
		owner: string,
		name: string,
		base: string,
		head: string,
	) => Effect.Effect<
		ReadonlyArray<GithubCommit>,
		IntegrationsValidationError | IntegrationsUpstreamError
	>
	readonly getInstallationMetadata: (
		installationId: number,
	) => Effect.Effect<
		GithubInstallation,
		IntegrationsValidationError | IntegrationsUpstreamError
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

		const listInstallationRepositories = Effect.fn(
			"GithubInstallationClient.listInstallationRepositories",
		)(function* (installationId: number) {
			const repos: GithubRepo[] = []
			let nextUrl: string | null = "/installation/repositories?per_page=100"
			while (nextUrl) {
				const response: Response = yield* authedFetch(installationId, nextUrl)
				if (!response.ok) {
					const text: string = yield* Effect.tryPromise({
						try: () => response.text(),
						catch: () => toUpstreamError("listInstallationRepositories failed", response.status),
					})
					return yield* Effect.fail(
						toUpstreamError(
							`listInstallationRepositories failed (${response.status}): ${text || response.statusText}`,
							response.status,
						),
					)
				}
				const json: unknown = yield* Effect.tryPromise({
					try: () => response.json(),
					catch: () => toUpstreamError("listInstallationRepositories returned non-JSON"),
				})
				const decoded = yield* decodeInstallationRepos(json).pipe(
					Effect.mapError(() =>
						toUpstreamError("listInstallationRepositories returned unexpected payload"),
					),
				)
				repos.push(...decoded.repositories)
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
				url = `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(
					options.name,
				)}/commits?${params.toString()}`
			}
			const response: Response = yield* authedFetch(installationId, url)
			if (response.status === 409) {
				return { commits: [], nextCursor: null } satisfies CommitPage
			}
			if (!response.ok) {
				const text: string = yield* Effect.tryPromise({
					try: () => response.text(),
					catch: () => toUpstreamError("listCommitsPaginated failed", response.status),
				})
				return yield* Effect.fail(
					toUpstreamError(
						`listCommitsPaginated failed (${response.status}): ${text || response.statusText}`,
						response.status,
					),
				)
			}
			const json: unknown = yield* Effect.tryPromise({
				try: () => response.json(),
				catch: () => toUpstreamError("listCommitsPaginated returned non-JSON"),
			})
			const commits = yield* decodeCommits(json).pipe(
				Effect.mapError(() =>
					toUpstreamError("listCommitsPaginated returned unexpected payload"),
				),
			)
			const nextCursor = parseNextLink(response.headers.get("link"))
			return { commits, nextCursor } satisfies CommitPage
		})

		const getCommit = Effect.fn("GithubInstallationClient.getCommit")(function* (
			installationId: number,
			owner: string,
			name: string,
			sha: string,
		) {
			const response: Response = yield* authedFetch(
				installationId,
				`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(sha)}`,
			)
			if (response.status === 404 || response.status === 422) return null
			if (!response.ok) {
				const text: string = yield* Effect.tryPromise({
					try: () => response.text(),
					catch: () => toUpstreamError("getCommit failed", response.status),
				})
				return yield* Effect.fail(
					toUpstreamError(
						`getCommit failed (${response.status}): ${text || response.statusText}`,
						response.status,
					),
				)
			}
			const json: unknown = yield* Effect.tryPromise({
				try: () => response.json(),
				catch: () => toUpstreamError("getCommit returned non-JSON"),
			})
			return yield* decodeCommit(json).pipe(
				Effect.mapError(() => toUpstreamError("getCommit returned unexpected payload")),
			)
		})

		const listBranchesForCommit = Effect.fn(
			"GithubInstallationClient.listBranchesForCommit",
		)(function* (installationId: number, owner: string, name: string, sha: string) {
			const response: Response = yield* authedFetch(
				installationId,
				`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
					name,
				)}/commits/${encodeURIComponent(sha)}/branches-where-head`,
			)
			if (response.status === 404 || response.status === 422) {
				return [] as ReadonlyArray<string>
			}
			if (!response.ok) {
				return [] as ReadonlyArray<string>
			}
			const json: unknown = yield* Effect.tryPromise({
				try: () => response.json(),
				catch: () => toUpstreamError("listBranchesForCommit returned non-JSON"),
			})
			const decoded = yield* decodeBranches(json).pipe(
				Effect.mapError(() =>
					toUpstreamError("listBranchesForCommit returned unexpected payload"),
				),
			)
			return decoded.map((b) => b.name) as ReadonlyArray<string>
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
				`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
			)
			if (response.status === 404) return [] as ReadonlyArray<GithubCommit>
			if (!response.ok) {
				return [] as ReadonlyArray<GithubCommit>
			}
			const json: unknown = yield* Effect.tryPromise({
				try: () => response.json() as Promise<{ commits?: unknown }>,
				catch: () => toUpstreamError("compareRefs returned non-JSON"),
			})
			const raw = (json as { commits?: unknown }).commits ?? []
			const decoded = yield* decodeCommits(raw).pipe(
				Effect.mapError(() => toUpstreamError("compareRefs returned unexpected payload")),
			)
			return decoded as ReadonlyArray<GithubCommit>
		})

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
			if (!response.ok) {
				const text = yield* Effect.tryPromise({
					try: () => response.text(),
					catch: () => toUpstreamError("getInstallationMetadata failed", response.status),
				})
				return yield* Effect.fail(
					toUpstreamError(
						`getInstallationMetadata failed (${response.status}): ${text || response.statusText}`,
						response.status,
					),
				)
			}
			const json: unknown = yield* Effect.tryPromise({
				try: () => response.json(),
				catch: () => toUpstreamError("getInstallationMetadata returned non-JSON"),
			})
			return yield* decodeInstallation(json).pipe(
				Effect.mapError(() =>
					toUpstreamError("getInstallationMetadata returned unexpected payload"),
				),
			)
		})

		return {
			listInstallationRepositories,
			listCommitsPaginated,
			getCommit,
			listBranchesForCommit,
			compareRefs,
			getInstallationMetadata,
		} satisfies GithubInstallationClientShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(GithubAppJwtService.layer),
	)
	static readonly Default = this.layer
}
