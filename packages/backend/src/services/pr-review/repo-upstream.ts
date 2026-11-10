import { type OrgId, PrReviewPersistenceError, type VcsRepo } from "@maple/domain/http"
import { Effect, Option } from "effect"
import { VcsProviderRegistry } from "@maple/backend/services/integrations/vcs/VcsProviderRegistry"
import { VcsRepository } from "@maple/backend/services/integrations/vcs/VcsRepository"

/** Repository permissions that make a person a maintainer, whatever the webhook's association says. */
const PUSH_PERMISSIONS: ReadonlySet<string> = new Set(["admin", "maintain", "write"])

const toPersistence = (error: { readonly message: string }) =>
	new PrReviewPersistenceError({ message: error.message })

/** The provider, installation and reference a repository's reads and posts go through. */
export const makeRepoUpstream = Effect.gen(function* () {
	const repositories = yield* VcsRepository
	const providers = yield* VcsProviderRegistry

	const upstreamFor = Effect.fn("RepoUpstream.upstreamFor")(function* (orgId: OrgId, repo: VcsRepo) {
		const installation = yield* repositories
			.getInstallationById(orgId, repo.installationId)
			.pipe(Effect.mapError(toPersistence))
		if (Option.isNone(installation)) return Option.none()
		const provider = yield* providers.resolve(repo.provider).pipe(Effect.option)
		if (Option.isNone(provider)) return Option.none()
		return Option.some({
			provider: provider.value,
			installation: installation.value,
			ref: { externalRepoId: repo.externalRepoId, owner: repo.owner, name: repo.name },
		})
	})

	type Upstream = Option.Option.Value<Effect.Success<ReturnType<typeof upstreamFor>>>

	/** A person's permission on the repository, and whether it lets them push; unreadable is `"none"`. */
	const pushAccess = (upstream: Upstream, login: string) =>
		upstream.provider.fetchCommenterPermission(upstream.installation, upstream.ref, login).pipe(
			Effect.orElseSucceed(() => "none"),
			Effect.map((permission) => ({ permission, canPush: PUSH_PERMISSIONS.has(permission) })),
		)

	/** Whether a person can push to the repository; no login, no upstream or an unreadable permission is no. */
	const canPush = Effect.fn("RepoUpstream.canPush")(function* (
		orgId: OrgId,
		repo: VcsRepo,
		login: string | null,
	) {
		if (login === null) return false
		const upstream = yield* upstreamFor(orgId, repo)
		if (Option.isNone(upstream)) return false
		return (yield* pushAccess(upstream.value, login)).canPush
	})

	return { upstreamFor, pushAccess, canPush }
})
