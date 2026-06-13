import {
	type CommitUpsertInput,
	GitCommitSha,
	type RepoUpsertInput,
	type VcsInstallation,
	VcsInstallationGoneError,
	type VcsInstallationSyncReason,
	VcsProviderError,
	type VcsProviderId,
	type VcsRepositoryRef,
	VcsRepoUnavailableError,
	type VcsSyncJob,
	VcsWebhookParseError,
	VcsWebhookSignatureError,
} from "@maple/domain/http"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Env } from "../../lib/Env"
import type { VcsProviderClient, VcsWebhookRequest } from "../vcs/VcsProviderClient"
import { type GithubApiCommit, GithubAppClient, GithubAppError } from "./GithubAppClient"

const PROVIDER: VcsProviderId = "github"

// ---- Webhook payload schemas (minimal, permissive) ------------------------

const PushAuthor = Schema.Struct({
	name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	email: Schema.optionalKey(Schema.NullOr(Schema.String)),
	username: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

const PushCommit = Schema.Struct({
	id: GitCommitSha, // validated at decode — the 40-hex shape lives in the brand
	message: Schema.String,
	timestamp: Schema.optionalKey(Schema.String),
	url: Schema.String,
	author: Schema.optionalKey(PushAuthor),
})

const PushPayload = Schema.Struct({
	ref: Schema.String,
	repository: Schema.Struct({
		id: Schema.Number,
		owner: Schema.Struct({
			login: Schema.optionalKey(Schema.String),
			name: Schema.optionalKey(Schema.NullOr(Schema.String)),
		}),
	}),
	installation: Schema.Struct({ id: Schema.Number }),
	after: GitCommitSha, // the ref's new head SHA — authoritative, no ordering inference
	commits: Schema.optionalKey(Schema.Array(PushCommit)),
})

const InstallationPayload = Schema.Struct({
	action: Schema.String,
	installation: Schema.Struct({ id: Schema.Number }),
})

const decodePush = Schema.decodeUnknownEffect(PushPayload)
const decodeInstallationEvent = Schema.decodeUnknownEffect(InstallationPayload)

const parseError = (message: string) => new VcsWebhookParseError({ message })

// Decode an event payload, logging the structured cause server-side (so schema
// drift is diagnosable) while returning a generic 400-mapped error to the caller.
const parsePayload = <A, E>(event: string, decoded: Effect.Effect<A, E>) =>
	decoded.pipe(
		Effect.tapError((cause) =>
			Effect.logWarning("Invalid GitHub webhook payload").pipe(
				Effect.annotateLogs({ provider: PROVIDER, event, cause: String(cause) }),
			),
		),
		Effect.mapError(() => parseError(`Invalid ${event} payload`)),
	)

// Classify a GitHub HTTP failure into a semantic VCS error. HTTP-status
// knowledge lives here, in the provider — the orchestrator only ever sees the
// semantic outcome. A gone/410 on the installation-auth call is the
// authoritative disconnect signal; on a repo call it means the repo is gone;
// everything else (incl. 401/403/429/5xx) is transient and retryable.
const isGone = (status?: number) => status === 404 || status === 410

const toVcsError = (
	error: GithubAppError,
): VcsProviderError | VcsInstallationGoneError | VcsRepoUnavailableError => {
	if (isGone(error.status)) {
		if (error.scope === "installation") return new VcsInstallationGoneError({ message: error.message })
		if (error.scope === "repository") return new VcsRepoUnavailableError({ message: error.message })
	}
	return new VcsProviderError({
		message: error.message,
		...(error.status === undefined ? {} : { status: error.status }),
		...(error.cause === undefined ? {} : { cause: error.cause }),
	})
}

const finiteOrNull = (value: number) => (Number.isFinite(value) ? value : null)

const installationReason = (action: string): VcsInstallationSyncReason | null => {
	switch (action) {
		case "created":
			return "created"
		case "unsuspend":
			return "unsuspend"
		case "suspend":
			return "suspend"
		case "deleted":
			return "deleted"
		default:
			return null
	}
}

const timingSafeEqual = (a: string, b: string): boolean => {
	const ba = Buffer.from(a)
	const bb = Buffer.from(b)
	if (ba.length !== bb.length) return false
	let mismatch = 0
	for (let i = 0; i < ba.length; i += 1) mismatch |= ba[i]! ^ bb[i]!
	return mismatch === 0
}

const normalizeFetchedCommit = (commit: GithubApiCommit, branch: string, now: number): CommitUpsertInput => {
	const authoredAt = commit.commit.author?.date ? finiteOrNull(Date.parse(commit.commit.author.date)) : null
	const committedAt = commit.commit.committer?.date ? finiteOrNull(Date.parse(commit.commit.committer.date)) : null
	return {
		sha: commit.sha,
		message: commit.commit.message,
		authorName: commit.commit.author?.name ?? null,
		authorEmail: commit.commit.author?.email ?? null,
		authorLogin: commit.author?.login ?? null,
		authorAvatarUrl: commit.author?.avatar_url ?? null,
		authoredAt,
		committedAt: committedAt ?? authoredAt ?? now,
		htmlUrl: commit.html_url,
		branch,
	}
}

export class GithubProvider extends Context.Service<GithubProvider, VcsProviderClient>()(
	"@maple/api/services/github/GithubProvider",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const client = yield* GithubAppClient

			const verifySignature = (rawBody: string, signatureHeader: string | undefined) =>
				Effect.gen(function* () {
					const secret = env.GITHUB_APP_WEBHOOK_SECRET
					if (Option.isNone(secret)) {
						return yield* new VcsWebhookSignatureError({
							message: "GitHub webhook secret is not configured (GITHUB_APP_WEBHOOK_SECRET)",
						})
					}
					if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
						return yield* new VcsWebhookSignatureError({
							message: "Missing or malformed X-Hub-Signature-256 header",
						})
					}
					const enc = new TextEncoder()
					const key = yield* Effect.tryPromise({
						try: () =>
							crypto.subtle.importKey(
								"raw",
								enc.encode(Redacted.value(secret.value)),
								{ name: "HMAC", hash: "SHA-256" },
								false,
								["sign"],
							),
						catch: () =>
							new VcsWebhookSignatureError({ message: "Failed to import webhook secret" }),
					})
					const mac = yield* Effect.tryPromise({
						try: () => crypto.subtle.sign("HMAC", key, enc.encode(rawBody)),
						catch: () =>
							new VcsWebhookSignatureError({ message: "Failed to compute webhook signature" }),
					})
					const expected = `sha256=${Buffer.from(mac).toString("hex")}`
					if (!timingSafeEqual(expected, signatureHeader)) {
						return yield* new VcsWebhookSignatureError({ message: "Webhook signature mismatch" })
					}
				})

			const mapPush = (raw: unknown, now: number) =>
				Effect.gen(function* () {
					const payload = yield* parsePayload("push", decodePush(raw))
					if (!payload.ref.startsWith("refs/heads/")) return [] // ignore tag/other refs
					const branch = payload.ref.slice("refs/heads/".length)
					const commits: ReadonlyArray<CommitUpsertInput> = (payload.commits ?? []).map((c) => {
						const ts = c.timestamp ? finiteOrNull(Date.parse(c.timestamp)) : null
						return {
							sha: c.id,
							message: c.message,
							authorName: c.author?.name ?? null,
							authorEmail: c.author?.email ?? null,
							authorLogin: c.author?.username ?? null,
							authorAvatarUrl: null,
							authoredAt: ts,
							committedAt: ts ?? now,
							htmlUrl: c.url,
							branch,
						}
					})
					if (commits.length === 0) return []
					const job: VcsSyncJob = {
						kind: "push-delta",
						provider: PROVIDER,
						externalInstallationId: String(payload.installation.id),
						externalRepoId: String(payload.repository.id),
						branch,
						headSha: payload.after,
						commits,
					}
					return [job]
				})

			const mapInstallationEvent =
				(reasonFor: (action: string) => VcsInstallationSyncReason | null) => (raw: unknown) =>
					Effect.gen(function* () {
						const payload = yield* parsePayload("installation", decodeInstallationEvent(raw))
						const reason = reasonFor(payload.action)
						if (!reason) return []
						const job: VcsSyncJob = {
							kind: "installation-sync",
							provider: PROVIDER,
							externalInstallationId: String(payload.installation.id),
							reason,
						}
						return [job]
					})

			const mapInstallation = mapInstallationEvent(installationReason)
			const mapInstallationRepositories = mapInstallationEvent((action) =>
				action === "added"
					? "repositories_added"
					: action === "removed"
						? "repositories_removed"
						: null,
			)

			const webhookToJobs = (input: VcsWebhookRequest) =>
				Effect.gen(function* () {
					yield* verifySignature(input.rawBody, input.headers["x-hub-signature-256"])
					const parsed = yield* Effect.try({
						try: () => JSON.parse(input.rawBody) as unknown,
						catch: () => parseError("Invalid JSON body"),
					})
					const now = yield* Clock.currentTimeMillis
					switch (input.headers["x-github-event"]) {
						case "push":
							return yield* mapPush(parsed, now)
						case "installation":
							return yield* mapInstallation(parsed)
						case "installation_repositories":
							return yield* mapInstallationRepositories(parsed)
						default:
							return [] // ping and unhandled events are accepted no-ops
					}
				}).pipe(
					Effect.withSpan("GithubProvider.webhookToJobs", {
						attributes: {
							"vcs.provider": PROVIDER,
							"vcs.webhook.event": input.headers["x-github-event"] ?? "unknown",
						},
					}),
				)

			const fetchRepositories = (installation: VcsInstallation) =>
				client.listInstallationRepositories(installation.externalInstallationId).pipe(
					Effect.map((repos): ReadonlyArray<RepoUpsertInput> =>
						repos.map((r) => ({
							externalRepoId: String(r.id),
							owner: r.owner.login,
							name: r.name,
							fullName: r.full_name,
							defaultBranch: r.default_branch ?? "main",
							htmlUrl: r.html_url,
							isPrivate: r.private,
							isArchived: r.archived ?? false,
						})),
					),
					Effect.mapError(toVcsError),
				)

			const fetchCommits = (
				installation: VcsInstallation,
				repo: VcsRepositoryRef,
				opts: { readonly sinceMs: number },
			) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const commits = yield* client
						.listCommits(installation.externalInstallationId, repo.owner, repo.name, {
							sha: repo.defaultBranch,
							sinceIso: new Date(opts.sinceMs).toISOString(),
						})
						.pipe(Effect.mapError(toVcsError))
					const normalized = commits.map((c) => normalizeFetchedCommit(c, repo.defaultBranch, now))
					// GitHub's /commits endpoint returns newest-first, so the first row is
					// the branch head. This ordering knowledge stays inside the provider.
					return { commits: normalized, headSha: normalized[0]?.sha ?? null }
				})

			return {
				id: PROVIDER,
				webhookToJobs,
				fetchRepositories,
				fetchCommits,
			} satisfies VcsProviderClient
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
