import { GitCommitSha } from "@maple/domain/http"
import { Clock, Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Env } from "../../lib/Env"

// ---------------------------------------------------------------------------
// GitHub App REST client. Vendor-specific: mints a short-lived App JWT (RS256,
// Web Crypto), exchanges it for per-installation tokens, and calls the GitHub
// REST API. No Octokit (Worker bundle weight). This module never touches D1.
//
// `GithubAppError` is internal to the GitHub layer; `GithubProvider` maps it to
// the generic `VcsProviderError` at the port boundary.
// ---------------------------------------------------------------------------

export class GithubAppError extends Data.TaggedError("GithubAppError")<{
	message: string
	status?: number
	// Which resource the failing call addressed, so the provider can tell an
	// installation-auth failure (the gone/suspended signal) from a repo-level one.
	scope?: "installation" | "repository"
	cause?: unknown
}> {}

const GITHUB_API_VERSION = "2022-11-28"
const USER_AGENT = "maple-vcs-integration"
const PER_PAGE = 100
const MAX_PAGES = 20 // safety cap (≤2000 items)

// ---- REST response schemas ------------------------------------------------

const GithubInstallationTokenResponse = Schema.Struct({
	token: Schema.String,
	expires_at: Schema.String,
})

const GithubApiRepoSchema = Schema.Struct({
	id: Schema.Number,
	name: Schema.String,
	full_name: Schema.String,
	private: Schema.Boolean,
	archived: Schema.optionalKey(Schema.Boolean),
	default_branch: Schema.optionalKey(Schema.String),
	html_url: Schema.String,
	owner: Schema.Struct({ login: Schema.String }),
})
export type GithubApiRepo = Schema.Schema.Type<typeof GithubApiRepoSchema>

const GithubInstallationReposResponse = Schema.Struct({
	total_count: Schema.Number,
	repositories: Schema.Array(GithubApiRepoSchema),
})

const GithubApiCommitAuthor = Schema.Struct({
	name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	email: Schema.optionalKey(Schema.NullOr(Schema.String)),
	date: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

const GithubApiUser = Schema.Struct({
	login: Schema.String,
	avatar_url: Schema.optionalKey(Schema.String),
})

const GithubApiCommitSchema = Schema.Struct({
	sha: GitCommitSha, // validated at decode — the 40-hex shape lives in the brand
	html_url: Schema.String,
	commit: Schema.Struct({
		message: Schema.String,
		author: Schema.NullOr(GithubApiCommitAuthor),
		committer: Schema.optionalKey(Schema.NullOr(GithubApiCommitAuthor)),
	}),
	author: Schema.NullOr(GithubApiUser),
})
export type GithubApiCommit = Schema.Schema.Type<typeof GithubApiCommitSchema>

const GithubApiCommitList = Schema.Array(GithubApiCommitSchema)

const decodeInstallationToken = Schema.decodeUnknownEffect(GithubInstallationTokenResponse)
const decodeInstallationRepos = Schema.decodeUnknownEffect(GithubInstallationReposResponse)
const decodeCommitList = Schema.decodeUnknownEffect(GithubApiCommitList)
const decodeCommit = Schema.decodeUnknownEffect(GithubApiCommitSchema)

// ---- JWT (RS256 via Web Crypto) -------------------------------------------

const base64UrlString = (value: string) => Buffer.from(value, "utf8").toString("base64url")
const base64UrlBytes = (value: ArrayBuffer) => Buffer.from(value).toString("base64url")

const pemToPkcs8 = (pem: string): ArrayBuffer => {
	const body = pem
		.replace(/-----BEGIN[^-]+-----/g, "")
		.replace(/-----END[^-]+-----/g, "")
		.replace(/\s+/g, "")
	const buf = Buffer.from(body, "base64")
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

interface ResolvedAppConfig {
	readonly appId: string
	readonly privateKeyPem: string
	readonly apiBaseUrl: string
}

export class GithubAppClient extends Context.Service<GithubAppClient>()(
	"@maple/api/services/github/GithubAppClient",
	{
		make: Effect.gen(function* () {
			const env = yield* Env

			const resolveConfig: Effect.Effect<ResolvedAppConfig, GithubAppError> = Effect.gen(function* () {
				const appId = Option.getOrUndefined(env.GITHUB_APP_ID)
				const privateKey = Option.getOrUndefined(env.GITHUB_APP_PRIVATE_KEY)
				if (!appId || !privateKey) {
					return yield* new GithubAppError({
						message: "GitHub App is not configured (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)",
					})
				}
				return {
					appId,
					privateKeyPem: Redacted.value(privateKey),
					apiBaseUrl: env.GITHUB_API_BASE_URL.replace(/\/+$/, ""),
				}
			})

			const importSigningKey = (pem: string) =>
				Effect.tryPromise({
					try: () =>
						crypto.subtle.importKey(
							"pkcs8",
							pemToPkcs8(pem),
							{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
							false,
							["sign"],
						),
					catch: (cause) =>
						new GithubAppError({ message: "Failed to import GitHub App private key", cause }),
				})

			const mintAppJwt = Effect.fn("GithubAppClient.mintAppJwt")(function* (config: ResolvedAppConfig) {
				const nowSec = Math.floor((yield* Clock.currentTimeMillis) / 1000)
				const header = base64UrlString(JSON.stringify({ alg: "RS256", typ: "JWT" }))
				// iat back-dated 60s for clock skew; exp ≤ 10min per GitHub's limit.
				const payload = base64UrlString(
					JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: config.appId }),
				)
				const signingInput = `${header}.${payload}`
				const key = yield* importSigningKey(config.privateKeyPem)
				const signature = yield* Effect.tryPromise({
					try: () =>
						crypto.subtle.sign(
							"RSASSA-PKCS1-v1_5",
							key,
							new TextEncoder().encode(signingInput),
						),
					catch: (cause) => new GithubAppError({ message: "JWT signing failed", cause }),
				})
				return `${signingInput}.${base64UrlBytes(signature)}`
			})

			// ---- HTTP helpers ---------------------------------------------

			const failure = (
				response: Response,
				context: string,
				scope?: "installation" | "repository",
			) =>
				Effect.gen(function* () {
					const body = yield* Effect.tryPromise({
						try: () => response.text(),
						catch: () =>
							new GithubAppError({ message: `${context} failed`, status: response.status, scope }),
					})
					return yield* Effect.fail(
						new GithubAppError({
							message: `${context} failed: ${response.status} ${body.slice(0, 300)}`,
							status: response.status,
							scope,
						}),
					)
				})

			const parseJson = (response: Response, context: string) =>
				Effect.tryPromise({
					try: () => response.json() as Promise<unknown>,
					catch: (cause) =>
						new GithubAppError({ message: `${context} returned a non-JSON response`, cause }),
				})

			const mintInstallationToken = Effect.fn("GithubAppClient.mintInstallationToken")(function* (
				externalInstallationId: string,
			) {
				const config = yield* resolveConfig
				const jwt = yield* mintAppJwt(config)
				const response = yield* Effect.tryPromise({
					try: () =>
						fetch(`${config.apiBaseUrl}/app/installations/${externalInstallationId}/access_tokens`, {
							method: "POST",
							headers: {
								authorization: `Bearer ${jwt}`,
								accept: "application/vnd.github+json",
								"x-github-api-version": GITHUB_API_VERSION,
								"user-agent": USER_AGENT,
							},
						}),
					catch: (cause) =>
						new GithubAppError({ message: "Installation token request failed", cause }),
				})
				// A failure here is the installation auth gate — the authoritative
				// "installation gone / suspended" signal.
				if (!response.ok) return yield* failure(response, "Installation token request", "installation")
				const json = yield* parseJson(response, "Installation token request")
				const decoded = yield* decodeInstallationToken(json).pipe(
					Effect.mapError(
						(cause) =>
							new GithubAppError({ message: "Unexpected installation token payload", cause }),
					),
				)
				return decoded.token
			})

			const authedGet = (config: ResolvedAppConfig, token: string, url: string) =>
				Effect.tryPromise({
					try: () =>
						fetch(url, {
							headers: {
								authorization: `token ${token}`,
								accept: "application/vnd.github+json",
								"x-github-api-version": GITHUB_API_VERSION,
								"user-agent": USER_AGENT,
							},
						}),
					catch: (cause) => new GithubAppError({ message: `GitHub request failed: ${url}`, cause }),
				})

			const listInstallationRepositories = Effect.fn("GithubAppClient.listInstallationRepositories")(
				function* (externalInstallationId: string) {
					const config = yield* resolveConfig
					const token = yield* mintInstallationToken(externalInstallationId)
					const repos: Array<GithubApiRepo> = []
					for (let page = 1; page <= MAX_PAGES; page++) {
						const response = yield* authedGet(
							config,
							token,
							`${config.apiBaseUrl}/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
						)
						if (!response.ok) return yield* failure(response, "List installation repositories")
						const json = yield* parseJson(response, "List installation repositories")
						const decoded = yield* decodeInstallationRepos(json).pipe(
							Effect.mapError(
								(cause) =>
									new GithubAppError({
										message: "Unexpected installation repositories payload",
										cause,
									}),
							),
						)
						repos.push(...decoded.repositories)
						if (decoded.repositories.length < PER_PAGE) break
					}
					return repos
				},
			)

			const listCommits = Effect.fn("GithubAppClient.listCommits")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				params: { sha?: string; sinceIso?: string },
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const base = `${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`
				const commits: Array<GithubApiCommit> = []
				for (let page = 1; page <= MAX_PAGES; page++) {
					const query = new URLSearchParams({ per_page: String(PER_PAGE), page: String(page) })
					if (params.sha) query.set("sha", params.sha)
					if (params.sinceIso) query.set("since", params.sinceIso)
					const response = yield* authedGet(config, token, `${base}?${query.toString()}`)
					// 409 = empty repository, 404 = not found/no access → no commits.
					if (response.status === 404 || response.status === 409) break
					if (!response.ok) return yield* failure(response, "List commits", "repository")
					const json = yield* parseJson(response, "List commits")
					const decoded = yield* decodeCommitList(json).pipe(
						Effect.mapError(
							(cause) => new GithubAppError({ message: "Unexpected commits payload", cause }),
						),
					)
					commits.push(...decoded)
					if (decoded.length < PER_PAGE) break
				}
				return commits
			})

			const getCommit = Effect.fn("GithubAppClient.getCommit")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				sha: string,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const response = yield* authedGet(
					config,
					token,
					`${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${sha}`,
				)
				if (!response.ok) return yield* failure(response, "Get commit", "repository")
				const json = yield* parseJson(response, "Get commit")
				return yield* decodeCommit(json).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected commit payload", cause }),
					),
				)
			})

			return { mintInstallationToken, listInstallationRepositories, listCommits, getCommit }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
