/**
 * The size a connected repository's provider reports, read before the sandbox clones anything, so
 * an oversized repository is refused at target creation and run start rather than after its clone.
 */
import type { OrgId } from "@maple/domain/primitives"
import { Context, Effect, Layer, Option } from "effect"
import { VcsSourceService } from "@maple/backend/services/integrations/vcs/VcsSourceService"

export interface SecurityAuditRepositorySizeApi {
	/**
	 * Bytes the provider reports; None when it cannot say. The post-clone probe stays the precise
	 * gate, so an unanswered pre-check lets the run reach it.
	 */
	readonly bytes: (orgId: OrgId, repository: string) => Effect.Effect<Option.Option<number>>
}

export class SecurityAuditRepositorySize extends Context.Service<
	SecurityAuditRepositorySize,
	SecurityAuditRepositorySizeApi
>()("@maple/backend/services/security-audit/SecurityAuditRepositorySize", {
	make: Effect.gen(function* () {
		const vcs = yield* VcsSourceService
		const bytes: SecurityAuditRepositorySizeApi["bytes"] = Effect.fn("SecurityAuditRepositorySize.bytes")(
			function* (orgId, repository) {
				return yield* vcs.repositorySizeBytes(orgId, repository).pipe(
					Effect.map(Option.some),
					Effect.catch((error) =>
						Effect.logWarning("Could not read a repository's size before its clone").pipe(
							Effect.annotateLogs({ orgId, repository, error: error.message }),
							Effect.as(Option.none<number>()),
						),
					),
				)
			},
		)
		return { bytes } satisfies SecurityAuditRepositorySizeApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(VcsSourceService.layer))

	/** Sizes by `owner/name` for tests and harnesses; an unlisted repository has no answer. */
	static readonly fixed = (sizes: Readonly<Record<string, number>>) =>
		Layer.succeed(this, {
			bytes: (_orgId, repository) => Effect.succeed(Option.fromUndefinedOr(sizes[repository])),
		})
}
