import { strictEqual, ok } from "node:assert"
import { describe, it } from "vitest"
import { Effect, ManagedRuntime, Array as Arr, String as Str } from "effect"
import { Maple } from "@maple-dev/effect-sdk/server"
import { observeEventing } from "@maple/local-server/eventing/telemetry"

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
			await runtime.runPromise(
				observeEventing({ operation: "outbox_stage", outcome: "success", count: 3 }),
			)
			await runtime.runPromise(
				Effect.repeat(Effect.sleep("10 millis"), {
					until: () =>
						Arr.some(bodies, (body) => Str.includes("maple.eventing.operations_total")(body)),
				}).pipe(Effect.timeout("2 seconds")),
			)
			const exported = Arr.join(bodies, "\n")
			ok(Str.includes("maple.eventing.operations_total")(exported))
			ok(Str.includes("outbox_stage")(exported))
			strictEqual(Str.includes("tenantid")(exported), false)
		} finally {
			await runtime.dispose()
			await server.stop(true)
		}
	})
})
