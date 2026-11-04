import { MapleInternalApi } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { Effect, Exit, Layer, Tracer } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import {
	MapleApiV2Http,
	MapleInternalHttp,
	WarehouseExecutor,
} from "@maple/web-data/warehouse/warehouse-services"
import { describe, expect, test } from "vitest"
import { FetchWidget } from "./command"

/** An unknown endpoint fails before any service is reached; these only satisfy the types. */
const UnusedWarehouse = Layer.mergeAll(
	Layer.mock(WarehouseExecutor, {}),
	Layer.effect(MapleInternalHttp, HttpApiClient.make(MapleInternalApi)),
	Layer.effect(MapleApiV2Http, HttpApiClient.make(MapleApiV2)),
).pipe(
	Layer.provide(FetchHttpClient.layer),
	Layer.provide(
		Layer.succeed(FetchHttpClient.Fetch, () => Promise.reject(new Error("unmocked widget request"))),
	),
)

const recordSpans = () => {
	const spans: Array<Tracer.NativeSpan> = []
	const tracer = Tracer.make({
		span: (options) => {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	return { spans, tracer }
}

describe("a widget fetch's spans", () => {
	test("a failed fetch records an Error span with its kind, while the command still answers", async () => {
		const { spans, tracer } = recordSpans()
		const command = FetchWidget({ key: "k", endpoint: "not_a_widget_endpoint", params: {} })
		const message = await Effect.runPromise(
			command.effect.pipe(
				Effect.withSpan("FetchDashboardWidget"),
				Effect.provide(UnusedWarehouse),
				Effect.provideService(Tracer.Tracer, tracer),
			),
		)
		expect(message.result._tag).toBe("Failure")
		const fetch = spans.find((span) => span.name === "dashboard.widget.fetch")
		expect(fetch?.status._tag === "Ended" && Exit.isFailure(fetch.status.exit)).toBe(true)
		expect(fetch?.attributes.get("maple.dashboard.widget.failure_kind")).toBe("runtime")
		const outer = spans.find((span) => span.name === "FetchDashboardWidget")
		expect(outer?.attributes.get("maple.dashboard.widget.endpoint")).toBe("unknown")
	})
})
