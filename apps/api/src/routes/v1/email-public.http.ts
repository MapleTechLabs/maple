import { HttpApiBuilder } from "effect/http-api"
import { Effect } from "effect"
import { MapleApi } from "@maple/domain/http"
import { DigestService } from "@maple/backend/services/digest/DigestService"

// Unauthenticated by design: the signed token is the credential, so a recipient can
// unsubscribe without a Maple session (and mail clients can one-click POST here).
export const HttpEmailPublicLive = HttpApiBuilder.group(MapleApi, "emailPublic", (handlers) =>
	Effect.gen(function* () {
		const digest = yield* DigestService

		return handlers.handle("unsubscribe", ({ query }) => digest.unsubscribeByToken(query.token))
	}),
)
