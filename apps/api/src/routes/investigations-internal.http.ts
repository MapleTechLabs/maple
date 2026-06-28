import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Effect, Match, Schema } from "effect"
import { InvestigationId, SubmitDiagnosisRequest } from "@maple/domain/http"
import { resolveMcpTenantContext } from "../mcp/lib/resolve-tenant"
import { InvestigationService } from "../services/InvestigationService"

const decodeIdEffect = Schema.decodeUnknownEffect(InvestigationId)
const decodeBodyEffect = Schema.decodeUnknownEffect(SubmitDiagnosisRequest)

const ID_FROM_PATH = /\/investigations\/([^/]+)\/diagnosis\/?$/

const errorJson = (message: string, status: number) =>
	HttpServerResponse.json({ error: message }, { status })

/**
 * Internal `submit_diagnosis` write the chat-flue investigate agent posts once
 * it finishes its diagnostic pass:
 *
 *   POST /api/internal/investigations/:id/diagnosis
 *
 * Server-to-server, so it authenticates with the internal-service token
 * (`Bearer maple_svc_<token>` + `x-org-id`) via the same `resolveMcpTenantContext`
 * the MCP server uses — NOT the Clerk session middleware on the user-facing
 * `InvestigationApiGroup`. The org is taken from the resolved tenant, so a
 * service caller can only write investigations in the org it names.
 */
export const InvestigationInternalRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const service = yield* InvestigationService

		const submitDiagnosis = Effect.gen(function* () {
			const req = yield* HttpServerRequest.HttpServerRequest
			// Map to a string literal (not a bare `Error`): the tagged service errors
			// below are subtypes of `Error`, so an `Error` in the channel would collapse
			// the union and erase their tags before `Match` can narrow them.
			const nativeReq = yield* HttpServerRequest.toWeb(req).pipe(
				Effect.mapError(() => "request_read" as const),
			)

			const tenant = yield* resolveMcpTenantContext(nativeReq).pipe(
				Effect.mapError(() => "unauthorized" as const),
			)

			const match = new URL(nativeReq.url).pathname.match(ID_FROM_PATH)
			if (!match?.[1]) return yield* Effect.fail("bad_path" as const)
			const id = yield* decodeIdEffect(match[1]).pipe(Effect.mapError(() => "bad_id" as const))

			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, investigationId: id })

			const body = yield* req.json.pipe(Effect.mapError(() => "bad_json" as const))
			const request = yield* decodeBodyEffect(body).pipe(Effect.mapError(() => "bad_payload" as const))

			yield* service.submitDiagnosis(tenant.orgId, id, request)

			return yield* HttpServerResponse.json({ ok: true })
		}).pipe(
			// Auth/decode steps fail with string literals; the service surfaces tagged
			// errors. One matcher narrows both channels: `when` for the string failures,
			// `tag` for not-found, with persistence/unknown falling through to 503.
			Effect.catch((error) =>
				Match.value(error).pipe(
					Match.when("unauthorized", () => errorJson("Unauthorized", 401)),
					Match.whenOr("bad_path", "bad_id", () => errorJson("Invalid investigation id", 400)),
					Match.whenOr("bad_json", "bad_payload", () => errorJson("Invalid diagnosis payload", 400)),
					Match.tag("@maple/http/investigations/InvestigationNotFoundError", () =>
						errorJson("No such investigation", 404),
					),
					Match.orElse(() => errorJson("Failed to persist diagnosis", 503)),
				),
			),
			Effect.catchCause(() => errorJson("Failed to persist diagnosis", 503)),
			Effect.withSpan("InvestigationInternal.submitDiagnosis"),
		)

		yield* router.add("POST", "/api/internal/investigations/:id/diagnosis", submitDiagnosis)
	}),
)
