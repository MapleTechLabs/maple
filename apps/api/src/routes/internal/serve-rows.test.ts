import { describe, expect, it } from "@effect/vitest"
import {
	CurrentTenant,
	ErrorDetailTracesResponse,
	ErrorsByTypeResponse,
	ErrorsSummaryResponse,
	FingerprintHash,
} from "@maple/domain/http"
import { DateTime, Effect, Exit, Schema } from "effect"
import { serveData } from "./serve-rows"

const TENANT = new CurrentTenant.TenantSchema({
	orgId: "org_serve_rows" as CurrentTenant.TenantSchema["orgId"],
	userId: "user_serve_rows" as CurrentTenant.TenantSchema["userId"],
	roles: [],
	authMode: "self_hosted",
})

const errorRow = (fingerprintHash: string) => ({
	fingerprintHash,
	errorLabel: "TypeError",
	sampleMessage: "boom",
	count: 3,
	affectedServicesCount: 1,
	firstSeen: DateTime.makeUnsafe("2026-11-01T10:00:00Z"),
	lastSeen: DateTime.makeUnsafe("2026-11-02T11:30:00.250Z"),
	// A column the response does not declare is dropped.
	rawSql: "SELECT 1",
})

const run = <A, E>(effect: Effect.Effect<A, E, CurrentTenant.Context>) =>
	Effect.runPromiseExit(Effect.provideService(effect, CurrentTenant.Context, TENANT))

describe("serveData", () => {
	it("answers with the rows as the response's data, timestamps as ISO strings", async () => {
		const handler = serveData(
			(_tenant, _payload: { readonly limit: number }) => Effect.succeed([errorRow("12345")]),
			ErrorsByTypeResponse,
		)
		const exit = await run(handler({ payload: { limit: 1 } }))
		expect(exit).toStrictEqual(
			Exit.succeed(
				new ErrorsByTypeResponse({
					data: [
						{
							fingerprintHash:
								"12345" as ErrorsByTypeResponse["data"][number]["fingerprintHash"],
							errorLabel: "TypeError",
							sampleMessage: "boom",
							count: 3,
							affectedServicesCount: 1,
							firstSeen: "2026-11-01T10:00:00.000Z",
							lastSeen: "2026-11-02T11:30:00.250Z",
						},
					],
				}),
			),
		)
	})

	it("passes the tenant and payload to the read", async () => {
		const seen: Array<string> = []
		const handler = serveData((tenant, payload: { readonly id: string }) => {
			seen.push(`${tenant.orgId}:${payload.id}`)
			return Effect.succeed(null)
		}, ErrorsSummaryResponse)
		const exit = await run(handler({ payload: { id: "p1" } }))
		expect(exit).toStrictEqual(Exit.succeed(new ErrorsSummaryResponse({ data: null })))
		expect(seen).toStrictEqual(["org_serve_rows:p1"])
	})

	it("dies when a row breaks the response's brand, as the hand mapping's decodeSync did", async () => {
		const trace = {
			traceId: "",
			startTime: DateTime.makeUnsafe("2026-11-01T10:00:00Z"),
			durationMicros: 10,
			spanCount: 1,
			services: ["api"],
			rootSpanName: "GET /",
			errorMessage: "boom",
		}
		const handler = serveData(() => Effect.succeed([trace]), ErrorDetailTracesResponse)
		const exit = await run(handler({ payload: undefined }))
		expect(Exit.isFailure(exit) && Exit.hasDies(exit)).toBe(true)
	})

	it("keeps the read's failure in the error channel", async () => {
		const handler = serveData(() => Effect.fail("warehouse down" as const), ErrorsByTypeResponse)
		const exit = await run(handler({ payload: undefined }))
		expect(exit).toStrictEqual(Exit.fail("warehouse down"))
	})
})
