import * as Policy from "@maple/domain/policy"
import { V2InsufficientPermissions } from "@maple/domain/http/v2"
import { Effect, Option, Predicate, Schema } from "effect"
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

const DeniedEnvelope = Schema.Struct({
	error: Schema.Struct({ code: Schema.Literal(V2InsufficientPermissions.code) }),
})

/** The refusal as the API answers it (the decoded envelope) or as the session check makes it (the class). */
const isPermissionDenied = (error: unknown): boolean =>
	Predicate.isTagged(error, V2InsufficientPermissions.tag) || Schema.is(DeniedEnvelope)(error)

/** The keys a setup screen shows: `privateKey` is null for a member, who reads the public one only. */
export type SetupKeyPair = Readonly<{ privateKey: string | null; publicKey: string }>

/** Both keys for an engineer and up; the public key alone for anyone else (it sends from servers too). */
export const retrieveSetupKeys = Effect.gen(function* () {
	const client = yield* MapleApiV2Client
	return yield* retrieveIngestKeys.pipe(
		Effect.map((keys): SetupKeyPair => ({ privateKey: keys.private_key, publicKey: keys.public_key })),
		// Only a refusal falls back: a key store outage must not hand an admin the public key.
		Effect.catchIf(isPermissionDenied, () =>
			Effect.map(client.ingestKeys.retrievePublic(), (key): SetupKeyPair => ({
				privateKey: null,
				publicKey: key.public_key,
			})),
		),
	)
})
