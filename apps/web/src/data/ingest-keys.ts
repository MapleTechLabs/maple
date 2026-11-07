import * as Policy from "@maple/domain/policy"
import { V2InsufficientPermissions } from "@maple/domain/http/v2"
import { Effect, Option } from "effect"
import { MapleApiV2Client } from "../platform/api-clients"
import { SessionTenant } from "./session-tenant"

/**
 * `ingestKeys.retrieve`, sent only for a session that may view the keys (engineer and up). Others
 * get the 403 body the API would answer, without the request. The roles come from the cached
 * session read; when that read fails the request goes out and the API decides.
 */
export const retrieveIngestKeys = Effect.gen(function* () {
	const maybeTenant = yield* Effect.option((yield* SessionTenant).get)
	if (Option.exists(maybeTenant, (tenant) => !Policy.can(tenant.roles, "ingest_keys:view")))
		return yield* V2InsufficientPermissions.make(Policy.denialFor("ingest_keys:view").message)
	return yield* (yield* MapleApiV2Client).ingestKeys.retrieve()
})

/** The keys a setup screen shows: `privateKey` is null for a member, who reads the public one only. */
export type SetupKeyPair = Readonly<{ privateKey: string | null; publicKey: string }>

/** Both keys for an engineer and up; the public key alone for anyone else (it sends from servers too). */
export const retrieveSetupKeys = Effect.gen(function* () {
	const client = yield* MapleApiV2Client
	return yield* retrieveIngestKeys.pipe(
		Effect.map((keys): SetupKeyPair => ({ privateKey: keys.private_key, publicKey: keys.public_key })),
		// The 403 arrives as the decoded public envelope, not the tagged class; any failure here
		// falls back to the read every member may make, and that one's failure is the answer.
		Effect.catch(() =>
			Effect.map(client.ingestKeys.retrievePublic(), (key): SetupKeyPair => ({
				privateKey: null,
				publicKey: key.public_key,
			})),
		),
	)
})
