import * as Policy from "@maple/domain/policy"
import { Effect, Schema } from "effect"
import { MapleApiV2Client } from "../platform/api-clients"
import { SessionTenant } from "./session-tenant"

/** The session's roles lack `ingest_keys:view` (members below engineer): the API would answer 403. */
export class IngestKeysNotPermittedError extends Schema.TaggedError<IngestKeysNotPermittedError>()(
	"@maple/web/errors/IngestKeysNotPermittedError",
	{ message: Schema.String },
) {}

/**
 * `ingestKeys.retrieve`, sent only for a session that may view the keys. The roles come from the
 * cached session read; when that read fails the request goes out and the API decides.
 */
export const retrieveIngestKeys = Effect.gen(function* () {
	const maybeTenant = yield* Effect.option((yield* SessionTenant).get)
	if (maybeTenant._tag === "Some" && !Policy.can(maybeTenant.value.roles, "ingest_keys:view"))
		return yield* new IngestKeysNotPermittedError({
			message: "Ask an engineer or admin in your organization for the ingest key.",
		})
	return yield* (yield* MapleApiV2Client).ingestKeys.retrieve()
})
