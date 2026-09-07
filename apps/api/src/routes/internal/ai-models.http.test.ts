// SAFETY-FILE: JSON in this test is emitted by the route under test before its fields are asserted.
import { describe, expect, it } from "@effect/vitest"
import {
	AiModelsInternalApiGroup,
	CurrentTenant,
	V1SchemaErrors,
	V1UnexpectedErrors,
} from "@maple/domain/http"
import { Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { V1ErrorBoundaryLive } from "../v1/error-boundary"
import { HttpAiModelsInternalLive } from "./ai-models.http"

class AiModelsOnlyApi extends HttpApi.make("MapleInternalApi")
	.add(AiModelsInternalApiGroup)
	.middleware(V1SchemaErrors)
	.middleware(V1UnexpectedErrors) {}

const TENANT = new CurrentTenant.TenantSchema({
	orgId: "org_ai_models" as CurrentTenant.TenantSchema["orgId"],
	userId: "user_ai_models" as CurrentTenant.TenantSchema["userId"],
	roles: [],
	authMode: "self_hosted",
})

const AuthorizationStubLayer = Layer.succeed(
	CurrentTenant.SessionAuthorization,
	CurrentTenant.SessionAuthorization.of({
		bearer: (httpEffect) => Effect.provideService(httpEffect, CurrentTenant.Context, TENANT),
	}),
)

const makeHarness = () => {
	const routes = HttpApiBuilder.layer(AiModelsOnlyApi).pipe(
		Layer.provide(HttpAiModelsInternalLive),
		Layer.provide(V1ErrorBoundaryLive),
		Layer.provideMerge(AuthorizationStubLayer),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes as never, { disableLogger: true })

	const post = async (body: unknown) => {
		// SAFETY: the handler's second argument is the Worker environment context,
		// and this route reads nothing out of it.
		const response = await handler(
			new Request("http://maple.test/internal/ai-models/detect", {
				method: "POST",
				headers: { authorization: "Bearer test-token", "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
			Context.empty() as never,
		)
		return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> }
	}

	return { post, dispose }
}

describe("POST /internal/ai-models/detect", () => {
	it("answers with the resolved vendor and display name", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.post({ model: "z-ai/glm-5.3-flash:nitro" })
			expect(response.status).toBe(200)
			expect(response.body).toMatchObject({
				slug: "glm-5.3-flash:nitro",
				normalizedSlug: "glm-5.3-flash",
				displayName: "GLM 5.3 Flash",
				vendorSlug: "z-ai",
				vendorName: "Z.ai",
				source: "openrouter",
			})
		} finally {
			await harness.dispose()
		}
	})

	it("rejects an empty model as a schema error rather than resolving it", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.post({ model: "" })
			expect(response.status).toBe(400)
		} finally {
			await harness.dispose()
		}
	})
})
