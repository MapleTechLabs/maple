import type { IngestKeyEncryptionError, IngestKeyPersistenceError } from "@maple/domain/http"
import type { OrgId, UserId } from "@maple/primitives"
import { Context, Effect, Layer, String as Str } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"

export interface IngestSetup {
	/** The deploy's own gateway, so an EU org gets the EU endpoint. */
	readonly ingestEndpoint: string
	readonly publicIngestKey: string
	readonly dashboardUrl: string
}

const withoutTrailingSlash = (url: string): string => Str.replace(/\/+$/, "")(url)

/** What a coding agent needs to send an org's first telemetry. Never the private key. */
export class IngestSetupService extends Context.Service<
	IngestSetupService,
	{
		readonly forOrg: (
			orgId: OrgId,
			userId: UserId,
		) => Effect.Effect<IngestSetup, IngestKeyPersistenceError | IngestKeyEncryptionError>
	}
>()("@maple/backend/services/IngestSetupService", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const ingestKeys = yield* OrgIngestKeysService

		const forOrg = Effect.fn("IngestSetupService.forOrg")(function* (orgId: OrgId, userId: UserId) {
			// Read past this isolate's memo: a key rolled in the API's isolate must never reach a new setup.
			yield* ingestKeys.forget(orgId)
			const keys = yield* ingestKeys.getOrCreate(orgId, userId)
			return {
				ingestEndpoint: withoutTrailingSlash(env.MAPLE_INGEST_PUBLIC_URL),
				publicIngestKey: keys.publicKey,
				dashboardUrl: withoutTrailingSlash(env.MAPLE_APP_BASE_URL),
			}
		})

		return { forOrg }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(OrgIngestKeysService.layer))
}
