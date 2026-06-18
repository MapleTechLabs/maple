import {
	type CommitUpsertInput,
	GitCommitSha,
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	isInstallationProcessable,
	type OrgId,
	type VcsCommit,
	type VcsInstallation,
	VcsCommitNotFoundError,
	VcsCommitShaInvalidError,
	type VcsProviderId,
	type VcsRepo,
} from "@maple/domain/http"
import { Clock, Context, Effect, Layer, Option, Result, Schema } from "effect"
import { VcsProviderRegistry } from "./VcsProviderRegistry"
import { VcsRepository } from "./VcsRepository"

// ---------------------------------------------------------------------------
// Resolves a commit by SHA for the dashboard's hover card — entirely vendor-
// agnostic. It only ever talks to `VcsRepository` (storage) and a
// `VcsProviderClient` obtained from the registry; it never imports a provider
// module. Adding a provider needs no change here.
//
// The SHA comes from telemetry (`deployment.commit_sha`) and carries no repo
// association, so resolution is by SHA across the whole org:
//   1. stored?  → return the DB row (the common, fast path)
//   2. else     → probe each connected repo via `provider.fetchCommit` until one
//                 resolves, persist it, and return it
//   3. else     → not found (cached briefly so repeated hovers don't re-probe)
// ---------------------------------------------------------------------------

// How long a "no repo has this SHA" result is remembered, so a stream of hovers
// on an unresolvable SHA doesn't re-scan every repo against the provider each
// time. Short, because a backfill may land the commit moments later.
const NEGATIVE_TTL_MS = 60_000

export interface VcsCommitDetail {
	readonly provider: VcsProviderId
	readonly sha: GitCommitSha
	readonly message: string
	readonly authorName: string | null
	readonly authorEmail: string | null
	readonly authorLogin: string | null
	readonly authorAvatarUrl: string | null
	readonly authoredAt: number | null
	readonly committedAt: number
	readonly htmlUrl: string
	readonly repoFullName: string
	readonly resolved: "stored" | "fetched"
}

export interface VcsCommitServiceShape {
	readonly resolveCommitDetail: (
		orgId: OrgId,
		sha: string,
	) => Effect.Effect<
		VcsCommitDetail,
		| VcsCommitShaInvalidError
		| VcsCommitNotFoundError
		| IntegrationsNotConnectedError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
	>
}

// Storage / decode errors all carry a `message`; collapse them to the
// persistence error the HTTP layer speaks.
const asPersistence = <A, E extends { readonly message: string }>(
	eff: Effect.Effect<A, E>,
): Effect.Effect<A, IntegrationsPersistenceError> =>
	eff.pipe(Effect.mapError((error) => new IntegrationsPersistenceError({ message: error.message })))

const decodeSha = Schema.decodeUnknownEffect(GitCommitSha)

const detailFromCommit = (commit: VcsCommit, repoFullName: string): VcsCommitDetail => ({
	provider: commit.provider,
	sha: commit.sha,
	message: commit.message,
	authorName: commit.authorName,
	authorEmail: commit.authorEmail,
	authorLogin: commit.authorLogin,
	authorAvatarUrl: commit.authorAvatarUrl,
	authoredAt: commit.authoredAt,
	committedAt: commit.committedAt,
	htmlUrl: commit.htmlUrl,
	repoFullName,
	resolved: "stored",
})

const detailFromInput = (
	input: CommitUpsertInput,
	repository: VcsRepo,
	sha: GitCommitSha,
): VcsCommitDetail => ({
	provider: repository.provider,
	sha,
	message: input.message,
	authorName: input.authorName,
	authorEmail: input.authorEmail,
	authorLogin: input.authorLogin,
	authorAvatarUrl: input.authorAvatarUrl,
	authoredAt: input.authoredAt,
	committedAt: input.committedAt,
	htmlUrl: input.htmlUrl,
	repoFullName: repository.fullName,
	resolved: "fetched",
})

export class VcsCommitService extends Context.Service<VcsCommitService, VcsCommitServiceShape>()(
	"@maple/api/services/vcs/VcsCommitService",
	{
		make: Effect.gen(function* () {
			const repo = yield* VcsRepository
			const registry = yield* VcsProviderRegistry
			// Per-isolate negative cache (orgId:sha → expiry ms). Best-effort; not
			// shared across isolates, which is fine — it only suppresses redundant
			// provider probes within a single hover session.
			const negativeCache = new Map<string, number>()

			// Check if a commit exists upstream in any of the installed installations.
			const probeInstallations = Effect.fn("VcsCommitService.probeInstallations")(function* (
				orgId: OrgId,
				sha: GitCommitSha,
				installations: ReadonlyArray<VcsInstallation>,
			) {
				let reposProbed = 0
				for (const installation of installations) {
					const provider = yield* registry
						.resolve(installation.provider)
						.pipe(Effect.mapError((e) => new IntegrationsUpstreamError({ message: e.message })))
					const repos = yield* asPersistence(
						repo.listRepositoriesByInstallation(installation.id, "active"),
					)
					for (const repository of repos) {
						reposProbed += 1
						const outcome = yield* Effect.result(
							provider.fetchCommit(
								installation,
								{
									externalRepoId: repository.externalRepoId,
									owner: repository.owner,
									name: repository.name,
								},
								sha,
							),
						)

						if (Result.isFailure(outcome)) {
							// In this branch we don't care about upstream failures, we do 
							// our best effort to resolve the commit and return nothing otherwise.
							continue
						}
						if (Option.isNone(outcome.success)) continue

						yield* Effect.annotateCurrentSpan({
							"vcs.commit.repos_probed": reposProbed,
							"vcs.commit.provider": installation.provider,
							"vcs.commit.outcome": "resolved",
							"vcs.repository.id": repository.id,
						})
						return {
							_tag: "resolved" as const,
							normalized: outcome.success.value,
							repository,
							reposProbed,
						}
					}
				}

				yield* Effect.annotateCurrentSpan({
					"vcs.commit.repos_probed": reposProbed,
					"vcs.commit.outcome": "not_found",
				})
				return ({ _tag: "not_found" as const, reposProbed } as const)
			})

			const resolveCommitDetail = Effect.fn("VcsCommitService.resolveCommitDetail")(function* (
				orgId: OrgId,
				rawSha: string,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })

				// Unguarded telemetry SHA: a non-40-hex value is a typed, non-retryable
				// error the dashboard renders as a muted "non-standard reference".
				const sha = yield* decodeSha(rawSha).pipe(
					Effect.mapError(
						() =>
							new VcsCommitShaInvalidError({
								message:
									"Commit reference is not a 40-character hex SHA — it may be a short SHA or a non-standard deployment identifier.",
								sha: rawSha,
							}),
					),
					Effect.tapError(() =>
						Effect.annotateCurrentSpan({
							"vcs.commit.outcome": "rejected",
							"vcs.commit.reason": "invalid_sha",
						}),
					),
				)
				yield* Effect.annotateCurrentSpan({ "vcs.commit.sha": sha })

				// 1. Fast path — already stored.
				const storedOpt = yield* asPersistence(repo.findCommitBySha(orgId, sha))
				if (Option.isSome(storedOpt)) {
					const stored = storedOpt.value
					const repoOpt = yield* asPersistence(repo.getRepositoryById(orgId, stored.repositoryId))
					const repoFullName = Option.match(repoOpt, {
						onNone: () => "",
						onSome: (r) => r.fullName,
					})
					yield* Effect.annotateCurrentSpan({
						"vcs.commit.outcome": "resolved",
						"vcs.commit.reason": "stored_hit",
						"vcs.commit.source": "stored",
						"vcs.repository.id": stored.repositoryId,
					})
					return detailFromCommit(stored, repoFullName)
				}

				const cacheKey = `${orgId}:${sha}`
				const now = yield* Clock.currentTimeMillis
				const cachedUntil = negativeCache.get(cacheKey)
				if (cachedUntil !== undefined && cachedUntil > now) {
					yield* Effect.annotateCurrentSpan({
						"vcs.commit.outcome": "not_found",
						"vcs.commit.reason": "negative_cache_hit",
						"vcs.commit.source": "cache",
					})
					return yield* new VcsCommitNotFoundError({
						message: "No connected repository contains this commit.",
						sha,
					})
				}
				if (cachedUntil !== undefined) negativeCache.delete(cacheKey)

				// 2. Resolve on the fly. Only processable (active) installations count.
				const installations = (yield* asPersistence(repo.listInstallationsByOrg(orgId))).filter(
					isInstallationProcessable,
				)
				yield* Effect.annotateCurrentSpan({ "vcs.commit.installations_probed": installations.length })
				if (installations.length === 0) {
					yield* Effect.annotateCurrentSpan({
						"vcs.commit.outcome": "rejected",
						"vcs.commit.reason": "not_connected",
					})
					return yield* new IntegrationsNotConnectedError({
						message: "No VCS provider is connected for this organization.",
					})
				}

				const probe = yield* probeInstallations(orgId, sha, installations)
				yield* Effect.annotateCurrentSpan({
					"vcs.commit.source": "probe",
					"vcs.commit.repos_probed": probe.reposProbed,
				})

				if (probe._tag === "resolved") {
					// Hit. Persist best-effort (a write failure must not fail the read) and
					// return the freshly resolved detail.
					const { normalized, repository } = probe
					const persisted = yield* asPersistence(repo.upsertCommits(repository, [normalized])).pipe(
						Effect.as(true),
						Effect.catch((e) =>
							Effect.logWarning("[VCS] Resolved commit but failed to persist it").pipe(
								Effect.annotateLogs({
									orgId,
									"vcs.commit.sha": sha,
									"vcs.commit.reason": "persist_failed",
									error: e.message,
								}),
								Effect.as(false),
							),
						),
					)
					yield* Effect.annotateCurrentSpan({
						"vcs.commit.outcome": "resolved",
						"vcs.commit.reason": persisted ? "resolved_via_probe" : "persist_failed",
						"vcs.repository.id": repository.id,
					})
					return detailFromInput(normalized, repository, sha)
				}


				// Clean miss across every repo — cache it briefly.
				negativeCache.set(cacheKey, now + NEGATIVE_TTL_MS)
				yield* Effect.annotateCurrentSpan({
					"vcs.commit.outcome": "not_found",
					"vcs.commit.reason": "not_found",
				})
				return yield* new VcsCommitNotFoundError({
					message: "No connected repository contains this commit.",
					sha,
				})
			})

			return { resolveCommitDetail } satisfies VcsCommitServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
