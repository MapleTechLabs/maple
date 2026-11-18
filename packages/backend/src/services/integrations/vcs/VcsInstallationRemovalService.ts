import { IntegrationsPersistenceError, IntegrationsUpstreamError, type OrgId } from "@maple/domain/http"
import { Array as Arr, Context, Effect, Layer } from "effect"
import { VcsProviderRegistry } from "./VcsProviderRegistry"
import { VcsRepository } from "./VcsRepository"

/** Installations of one org uninstalled at a time. */
const UNINSTALL_CONCURRENCY = 2

export interface VcsInstallationRemovalServiceApi {
	/**
	 * Org deletion only: uninstalls the provider's app from every account the org installed it on,
	 * so Maple's app key can mint no more tokens there. A plain disconnect in a living org keeps
	 * the app installed. The rows are left to the org purge.
	 */
	readonly uninstallForDeletedOrganization: (
		orgId: OrgId,
	) => Effect.Effect<
		{ readonly uninstalled: number },
		IntegrationsPersistenceError | IntegrationsUpstreamError
	>
}

export class VcsInstallationRemovalService extends Context.Service<
	VcsInstallationRemovalService,
	VcsInstallationRemovalServiceApi
>()("@maple/backend/services/vcs/VcsInstallationRemovalService", {
	make: Effect.gen(function* () {
		const repo = yield* VcsRepository
		const providers = yield* VcsProviderRegistry

		const uninstallForDeletedOrganization = Effect.fn(
			"VcsInstallationRemovalService.uninstallForDeletedOrganization",
		)(function* (orgId: OrgId) {
			const installations = yield* repo
				.listInstallationsByOrg(orgId)
				.pipe(
					Effect.mapError((error) => new IntegrationsPersistenceError({ message: error.message })),
				)
			// Every installation is tried: one the provider refuses must not keep the others installed.
			const uninstalled = yield* Effect.forEach(
				installations,
				(installation) =>
					providers.resolve(installation.provider).pipe(
						Effect.flatMap((provider) => provider.uninstallInstallation(installation)),
						Effect.as(true),
						Effect.catch((error) =>
							Effect.logWarning("VCS app installation was not uninstalled", {
								orgId,
								provider: installation.provider,
								installationId: installation.id,
								error: error.message,
							}).pipe(Effect.as(false)),
						),
					),
				{ concurrency: UNINSTALL_CONCURRENCY },
			)
			const failed = Arr.filter(uninstalled, (done) => !done).length
			yield* Effect.annotateCurrentSpan({
				orgId,
				"vcs.uninstall.installation_count": installations.length,
				"vcs.uninstall.failed_count": failed,
			})
			if (failed > 0) {
				return yield* new IntegrationsUpstreamError({
					message: `${failed} of ${installations.length} VCS app installations were not uninstalled`,
				})
			}
			return { uninstalled: installations.length }
		})

		return { uninstallForDeletedOrganization } satisfies VcsInstallationRemovalServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(VcsProviderRegistry.layer, VcsRepository.layer)),
	)
}
