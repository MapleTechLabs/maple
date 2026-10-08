import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { noTenantLayer, okUpstream, recordingElectricClient, syncRequest } from "../test-support"
import { ELECTRIC_SYNC_CORS_OPTIONS } from "./cors"
import { ElectricSyncRouter } from "./shape.http"

const app = ElectricSyncRouter.pipe(
	Layer.provideMerge(HttpRouter.cors(ELECTRIC_SYNC_CORS_OPTIONS)),
	Layer.provide(recordingElectricClient({ calls: [], respond: () => Effect.succeed(okUpstream()) })),
	Layer.provide(noTenantLayer),
)

describe("shape proxy CORS preflight", () => {
	it.effect("names Authorization and lets the browser cache the preflight", () =>
		Effect.gen(function* () {
			const { status, headers } = yield* syncRequest(
				app,
				"/api/sync/shape?shape=dashboards&offset=-1",
				{
					method: "OPTIONS",
					headers: {
						origin: "https://app.maple.dev",
						"access-control-request-method": "GET",
						"access-control-request-headers": "authorization",
					},
				},
			)
			assert.strictEqual(status, 204)
			assert.strictEqual(headers.get("access-control-allow-headers"), "*,Authorization")
			assert.strictEqual(headers.get("access-control-max-age"), "86400")
		}),
	)
})
