import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Effect, Schema } from "effect"
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
			const nativeReq = yield* HttpServerRequest.toWeb(req).pipe(
				Effect.mapError(() => new Error("request_read_failed")),
			)

			const tenant = yield* resolveMcpTenantContext(nativeReq).pipe(
				Effect.mapError(() => "unauthorized" as const),
			)

			const match = new URL(nativeReq.url).pathname.match(ID_FROM_PATH)
			if (!match?.[1]) return yield* Effect.fail("bad_path" as const)
			const id = yield* decodeIdEffect(match[1]).pipe(Effect.mapError(() => "bad_id" as const))

			const body = yield* req.json.pipe(Effect.mapError(() => "bad_json" as const))
			const request = yield* decodeBodyEffect(body).pipe(Effect.mapError(() => "bad_payload" as const))

			yield* service.submitDiagnosis(tenant.orgId, id, request).pipe(
				Effect.mapError((e) => (e._tag.endsWith("NotFoundError") ? "not_found" : "persistence")),
			)

			return yield* HttpServerResponse.json({ ok: true })
		}).pipe(
			Effect.catch((tag) => {
				switch (tag) {
					case "unauthorized":
						return errorJson("Unauthorized", 401)
					case "not_found":
						return errorJson("No such investigation", 404)
					case "bad_path":
					case "bad_id":
						return errorJson("Invalid investigation id", 400)
					case "bad_json":
					case "bad_payload":
						return errorJson("Invalid diagnosis payload", 400)
					default:
						return errorJson("Failed to persist diagnosis", 503)
				}
			}),
			Effect.catchCause(() => errorJson("Failed to persist diagnosis", 503)),
			Effect.withSpan("InvestigationInternal.submitDiagnosis"),
		)

		yield* router.add("POST", "/api/internal/investigations/:id/diagnosis", submitDiagnosis)
	}),
)
