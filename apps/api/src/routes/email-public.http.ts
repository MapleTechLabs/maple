import { HttpApiBuilder } from "effect/http-api"
import { Effect } from "effect"
import { MapleApi } from "@maple/domain/http"
import { DigestService } from "@maple/backend/services/digest/DigestService"

// Unauthenticated by design: the signed token is the credential, so a recipient can
// unsubscribe without a Maple session (and mail clients can one-click POST here).
export const HttpEmailPublicLive = HttpApiBuilder.group(MapleApi, "emailPublic", (handlers) =>
	Effect.gen(function* () {
		const digest = yield* DigestService

		// Server-kind with the HTTP identity stamped by hand: the auto server span is
		// suppressed for this path (it would record the token in `url.query`, see
		// ApiObservabilityLive), so this span is the request's trace root.
		const unsubscribe = Effect.fn("HttpEmailPublic.unsubscribe", {
			kind: "server",
			attributes: { "http.route": "/api/email/unsubscribe", "http.request.method": "POST" },
		})(function* (token: string) {
			return yield* digest.unsubscribeByToken(token).pipe(
				Effect.tap(() => Effect.annotateCurrentSpan("http.response.status_code", 200)),
				Effect.tapError((error) =>
					Effect.annotateCurrentSpan(
						"http.response.status_code",
						error._tag === "@maple/http/errors/DigestUnsubscribeTokenInvalidError" ? 400 : 503,
					),
				),
			)
		})

		return handlers.handle("unsubscribe", ({ query }) => unsubscribe(query.token))
	}),
)
