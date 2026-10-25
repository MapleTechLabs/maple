// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { beforeEach, expect, vi } from "vitest"
import { mockedWarehouse } from "./testing"

const executeQueryEngineMock = vi.fn()

vi.mock("./effect-utils", async () => {
	const actual = await vi.importActual<typeof import("./effect-utils")>("./effect-utils")
	return {
		...actual,
		executeQueryEngine: (...args: unknown[]) => executeQueryEngineMock(...args),
	}
})

import { isWarehouseApiError } from "./effect-utils"
import { getTracesFacets, listTraces } from "./traces"

describe("tinybird traces attribute filter params", () => {
	beforeEach(() => {
		executeQueryEngineMock.mockReset()
		executeQueryEngineMock.mockImplementation((operation: string) => {
			if (operation.includes("Facets")) {
				return Effect.succeed({ result: { kind: "facets", source: "traces", data: [] } })
			}
			if (operation.includes("DurationStats") || operation.includes("Stats")) {
				return Effect.succeed({
					result: {
						kind: "stats",
						source: "traces",
						data: { minDurationMs: 0, maxDurationMs: 0, p50DurationMs: 0, p95DurationMs: 0 },
					},
				})
			}
			return Effect.succeed({ result: { kind: "list", source: "traces", data: [] } })
		})
	})

	it.effect("forwards exists and comparison attribute filters with their mode, not as equality", () =>
		Effect.gen(function* () {
			yield* listTraces({
				data: {
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
					attributeFilters: [
						{ key: "user.id", value: "", matchMode: "exists" },
						{ key: "retry.count", value: "3", matchMode: "gt" },
					],
					resourceAttributeFilters: [
						{ key: "k8s.pod.name", value: "", matchMode: "exists", negated: true },
					],
				},
			})

			expect(executeQueryEngineMock).toHaveBeenCalledWith(
				"queryEngine.listTraces",
				expect.objectContaining({
					query: expect.objectContaining({
						filters: expect.objectContaining({
							attributeFilters: [
								{ key: "user.id", mode: "exists", negated: undefined },
								{ key: "retry.count", value: "3", mode: "gt", negated: undefined },
							],
							resourceAttributeFilters: [
								{ key: "k8s.pod.name", mode: "exists", negated: true },
							],
						}),
					}),
				}),
			)
		}).pipe(mockedWarehouse),
	)

	it.effect("fetches duration stats alongside the facets", () =>
		Effect.gen(function* () {
			yield* getTracesFacets({
				data: {
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
				},
			})

			expect(executeQueryEngineMock.mock.calls.map(([operation]) => operation).sort()).toEqual([
				"queryEngine.getTracesDurationStats",
				"queryEngine.getTracesFacets",
			])
		}).pipe(mockedWarehouse),
	)

	it.effect("builds a curated rootSpan summary for overview rows", () =>
		Effect.gen(function* () {
			executeQueryEngineMock.mockReturnValueOnce(
				Effect.succeed({
					result: {
						kind: "list",
						source: "traces",
						// Grouped (one-row-per-trace) shape — the default list mode.
						data: [
							{
								traceId: "trace-1",
								startTime: "2026-02-01 00:00:00",
								endTime: "2026-02-01 00:00:02",
								durationMs: 2000,
								spanCount: 12,
								services: ["gateway", "checkout", "payments"],
								rootSpanName: "GET",
								rootSpanKind: "Server",
								rootSpanStatusCode: "Ok",
								rootSpanAttributes: {
									"http.method": "GET",
									"http.route": "/checkout",
									"http.status_code": "200",
								},
								hasError: false,
							},
						],
					},
				}),
			)

			const response = yield* listTraces({
				data: {
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
				},
			})

			expect(response.data[0]).toMatchObject({
				services: ["gateway", "checkout", "payments"],
				spanCount: 12,
				rootSpanName: "GET",
				rootSpan: {
					name: "GET",
					kind: "Server",
					statusCode: "Ok",
					attributes: {
						"http.method": "GET",
						"http.route": "/checkout",
						"http.status_code": "200",
					},
					http: {
						method: "GET",
						route: "/checkout",
						statusCode: 200,
						isError: false,
					},
				},
			})
		}).pipe(mockedWarehouse),
	)

	it.effect("decodes per-span rows, accepting a numeric duration string and a numeric error flag", () =>
		Effect.gen(function* () {
			executeQueryEngineMock.mockReturnValueOnce(
				Effect.succeed({
					result: {
						kind: "list",
						source: "traces",
						data: [
							{
								traceId: "trace-2",
								timestamp: "2026-02-01T00:00:00.000Z",
								spanId: "span-2",
								parentSpanId: "span-1",
								serviceName: "checkout",
								spanName: "GET /cart",
								durationMs: "12.5",
								statusCode: "Error",
								spanKind: "Server",
								hasError: 1,
								services: ["checkout", "", "checkout"],
								spanAttributes: { "http.method": "GET", "db.system": "postgres" },
							},
						],
					},
				}),
			)

			const response = yield* listTraces({
				data: { startTime: "2026-02-01 00:00:00", endTime: "2026-02-01 01:00:00", rootOnly: false },
			})

			expect(response.data[0]).toMatchObject({
				spanId: "span-2",
				isRootSpan: false,
				durationMs: 12.5,
				services: ["checkout"],
				hasError: true,
				rootSpan: { name: "GET /cart", attributes: { "http.method": "GET" } },
			})
		}).pipe(mockedWarehouse),
	)

	it.effect("fails with WarehouseTransformError on a malformed list row", () =>
		Effect.gen(function* () {
			executeQueryEngineMock.mockReturnValueOnce(
				Effect.succeed({ result: { kind: "list", source: "traces", data: [{ traceId: 42 }] } }),
			)

			const error = yield* Effect.flip(
				listTraces({ data: { startTime: "2026-02-01 00:00:00", endTime: "2026-02-01 01:00:00" } }),
			)

			expect(isWarehouseApiError(error) && error._tag).toBe("@maple/web/errors/WarehouseTransformError")
		}).pipe(mockedWarehouse),
	)
})
