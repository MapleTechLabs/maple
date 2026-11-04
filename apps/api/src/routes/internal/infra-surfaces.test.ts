import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { settleInfraSurfaces } from "./infra-surfaces"

class LookupFailed extends Schema.TaggedError<LookupFailed>()("@maple/test/LookupFailed", {
	message: Schema.String,
}) {}

const lookups = {
	surfaces: Effect.succeed(["hosts", "k8sPods"] as const),
	cloudflare: Effect.succeed(true),
	railway: Effect.succeed(false),
	vercel: Effect.succeed(true),
	planetscale: Effect.succeed(true),
	gcp: Effect.succeed(false),
	supabase: Effect.succeed(false),
	aws: Effect.succeed(true),
}

describe("settleInfraSurfaces", () => {
	it.effect("answers the probe and every provider's status in one response", () =>
		Effect.gen(function* () {
			const response = yield* settleInfraSurfaces(lookups)
			expect(response.surfaces).toEqual(["hosts", "k8sPods"])
			expect(response.integrations).toEqual({
				cloudflare: true,
				railway: false,
				vercel: true,
				planetscale: true,
				gcp: false,
				supabase: false,
				aws: true,
			})
		}),
	)

	it.effect("a failing provider answers null while the others still answer", () =>
		Effect.gen(function* () {
			const response = yield* settleInfraSurfaces({
				...lookups,
				railway: Effect.fail(new LookupFailed({ message: "db down" })),
				surfaces: Effect.fail(new LookupFailed({ message: "warehouse down" })),
			})
			expect(response.surfaces).toBe(null)
			expect(response.integrations.railway).toBe(null)
			expect(response.integrations.cloudflare).toBe(true)
			expect(response.integrations.aws).toBe(true)
		}),
	)
})
