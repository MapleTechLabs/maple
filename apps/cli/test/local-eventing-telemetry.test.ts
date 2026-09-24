import { strictEqual, ok } from "node:assert"
import { describe, it } from "vitest"
import { Effect, ManagedRuntime } from "effect"
import { Maple } from "@maple-dev/effect-sdk/server"
import { makeEffectEventingTelemetry } from "../src/server/eventing/telemetry"

describe("eventing metric export", () => {
	it("exports eventing counters through the CLI's server SDK layer", async () => {
		const bodies: string[] = []
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (new URL(request.url).pathname === "/v1/metrics") bodies.push(await request.text())
				return Response.json({})
			},
		})
		const runtime = ManagedRuntime.make(
			Maple.layer({
				serviceName: "maple-cli-eventing-test",
				endpoint: `http://127.0.0.1:${server.port}`,
				ingestKey: "test-only",
				metricsExportInterval: "10 millis",
				shutdownTimeout: "1 second",
			}),
		)
		try {
			const pending: Promise<void>[] = []
			const telemetry = makeEffectEventingTelemetry((effect) =>
				pending.push(runtime.runPromise(effect)),
			)
			telemetry.record({ operation: "outbox_stage", outcome: "success", count: 3 })
			await Promise.all(pending)
			await runtime.runPromise(
				Effect.repeat(Effect.sleep("10 millis"), {
					until: () => bodies.some((body) => body.includes("maple.eventing.operations_total")),
				}).pipe(Effect.timeout("2 seconds")),
			)
			const exported = bodies.join("\n")
			ok(exported.includes("maple.eventing.operations_total"))
			ok(exported.includes("outbox_stage"))
			strictEqual(exported.includes("tenantid"), false)
		} finally {
			await runtime.dispose()
			server.stop(true)
		}
	})
})
