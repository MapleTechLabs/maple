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

// The wire shape is a hand-written mirror of the resolver's. Assignability at
// the constructor already catches a renamed or removed field; this catches a
// field the resolver gained that the wire would silently drop.
type MissingOnTheWire = Exclude<keyof DetectedAiModel, keyof DetectAiModelResponse>
const _everyFieldIsOnTheWire: MissingOnTheWire extends never ? true : never = true

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

	const postTo = async (path: string, body: unknown) => {
		// SAFETY: the handler's second argument is the Worker environment context,
		// and this route reads nothing out of it.
		const response = await handler(
			new Request(`http://maple.test/internal/ai-models/${path}`, {
				method: "POST",
				headers: { authorization: "Bearer test-token", "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
			Context.empty() as never,
		)
		return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> }
	}

	const post = (body: unknown) => postTo("detect", body)
	const postMany = async (body: unknown) => {
		const response = await postTo("detect-many", body)
		// SAFETY: same as the file header — the array is the route's own output.
		return { status: response.status, body: response.body as unknown as Array<Record<string, unknown>> }
	}

	return { post, postMany, dispose }
}

describe("POST /internal/ai-models/detect", () => {
	it("puts every resolved field on the wire", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.post({ model: "  z-ai/glm-5.3-flash:nitro " })
			expect(response.status).toBe(200)
			expect(response.body).toEqual({
				model: "z-ai/glm-5.3-flash:nitro",
				slug: "glm-5.3-flash:nitro",
				normalizedSlug: "glm-5.3-flash",
				openRouterId: "z-ai/glm-5.3-flash",
				displayName: "GLM 5.3 Flash (nitro)",
				vendorSlug: "z-ai",
				vendorName: "Z.ai",
				brandColor: null,
				family: null,
				source: "openrouter",
			})
		} finally {
			await harness.dispose()
		}
	})

	it("carries an unrecognised model's nulls as JSON null, which the icon lookup branches on", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.post({ model: "my-azure-deployment" })
			expect(response.status).toBe(200)
			expect(response.body).toMatchObject({
				openRouterId: null,
				vendorSlug: null,
				vendorName: null,
				brandColor: null,
				family: null,
				source: "unknown",
			})
		} finally {
			await harness.dispose()
		}
	})

	it("answers a prototype key as an unknown model, not a 500", async () => {
		const harness = makeHarness()
		try {
			for (const model of ["constructor/foo", "constructor.foo", "__proto__/foo"]) {
				const response = await harness.post({ model })
				expect(response.status).toBe(200)
				expect(response.body.source).toBe("unknown")
			}
		} finally {
			await harness.dispose()
		}
	})

	it.each(["", "   ", "x".repeat(501)])(
		"rejects %j as a schema error rather than resolving it",
		async (model) => {
			const harness = makeHarness()
			try {
				const response = await harness.post({ model })
				expect(response.status).toBe(400)
				expect(response.body._tag).toBe("@maple/http/v1/V1RequestValidationError")
			} finally {
				await harness.dispose()
			}
		},
	)
})

describe("POST /internal/ai-models/detect-many", () => {
	it("answers in request order, one entry per model", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.postMany({
				models: ["claude-sonnet-4-5-20250929", "my-azure-deployment", "gpt-4o-mini"],
			})
			expect(response.status).toBe(200)
			expect(response.body.map((model) => model.displayName)).toEqual([
				"Claude Sonnet 4.5",
				"My Azure Deployment",
				"GPT-4o-mini",
			])
			expect(response.body.map((model) => model.family)).toEqual(["claude", null, null])
			// The brand travels as a light/dark pair, or null where none is listed.
			expect(response.body.map((model) => model.brandColor)).toEqual([
				{ light: "#D97757", dark: "#D97757" },
				null,
				{ light: "#000000", dark: "#FFFFFF" },
			])
		} finally {
			await harness.dispose()
		}
	})

	it("rejects a batch past the cap rather than resolving it", async () => {
		const harness = makeHarness()
		try {
			const response = await harness.postMany({ models: Array.from({ length: 201 }, () => "gpt-4o") })
			expect(response.status).toBe(400)
		} finally {
			await harness.dispose()
		}
	})
})
