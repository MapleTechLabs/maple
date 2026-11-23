import { describe, expect, it } from "vitest"
import { Array as Arr, Effect, Layer, Schema, String as Str } from "effect"
import { WarehouseQueryError, type TenantContext } from "@maple/domain/http"
import type { IngestRuleSpec } from "@maple/domain/ingest-rules"
import { OrgId, UserId } from "@maple/primitives"
import { compiledQueryOf, type CompiledQueryInput } from "@maple/query-engine/execution"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import {
	IngestRulePreviewService,
	PREVIEW_MAX_SCAN_ROWS,
	scanMinutes,
	summarize,
} from "./IngestRulePreviewService"

describe("ingest rule preview totals", () => {
	const rows = [
		{ serviceName: "checkout", total: 1000, matched: 400 },
		{ serviceName: "api", total: 500, matched: 100 },
		{ serviceName: "quiet", total: 50, matched: 0 },
	]
	const sizes = new Map([
		["checkout", 300],
		["api", 1000],
	])

	it("drops each service's matches at that service's record size", () => {
		const preview = summarize("logs", rows, sizes, 1)
		expect(preview).toMatchObject({ stored: 1550, matched: 500, estimatedDropped: 500 })
		expect(preview.estimatedDroppedBytes).toBe(400 * 300 + 100 * 1000)
	})

	it("keeps the sampled share and counts no bytes for a service the usage rollup lacks", () => {
		const preview = summarize("traces", rows, new Map([["api", 1000]]), 0.9)
		expect(preview.estimatedDropped).toBe(450)
		expect(preview.estimatedDroppedBytes).toBe(90 * 1000)
	})

	it("scans the longest stretch of newest hours that fits, even after a burst", () => {
		const cap = PREVIEW_MAX_SCAN_ROWS
		expect(scanMinutes(Arr.makeBy(25, () => cap / 100))).toBe(24 * 60)
		// A burst ten hours back: the newest three hours (four buckets) fit, the rest do not.
		const burst = [cap / 10, cap / 10, cap / 10, cap / 10, ...Arr.makeBy(21, () => cap)]
		expect(scanMinutes(burst)).toBe(3 * 60)
		// Not even an hour fits: the minutes the busier of the two newest buckets allows.
		expect(scanMinutes([cap * 2, cap * 6])).toBe(10)
	})

	it("applies each service's match rate in the scanned stretch to its stored records for the day", () => {
		const scanned = summarize(
			"logs",
			rows,
			sizes,
			1,
			60,
			new Map([
				["checkout", 24_000],
				["api", 12_000],
			]),
		)
		expect(scanned.scannedMinutes).toBe(60)
		expect(scanned.services).toEqual([
			{ serviceName: "checkout", stored: 24_000, matched: 9600 },
			{ serviceName: "api", stored: 12_000, matched: 2400 },
		])
	})

	it("lists the services with matches, busiest first", () => {
		expect(summarize("logs", rows, sizes, 0).services).toEqual([
			{ serviceName: "checkout", stored: 1000, matched: 400 },
			{ serviceName: "api", stored: 500, matched: 100 },
		])
		expect(summarize("logs", rows, sizes, 0).estimatedDropped).toBe(0)
	})
})

describe("ingest rule preview errors", () => {
	const tenant: TenantContext = {
		orgId: Schema.decodeSync(OrgId)("org_preview_errors"),
		userId: Schema.decodeSync(UserId)("user_preview_errors"),
		roles: [],
		authMode: "self_hosted",
	}
	const spec: IngestRuleSpec = {
		signals: ["logs"],
		conditions: [{ field: "body", op: "regex", value: "^retry [0-9]+$" }],
		action: { _tag: "drop", keepPercent: 0 },
	}
	/** Sizing reads answer empty; the match count fails with `failure`. */
	const previewWith = (failure: WarehouseQueryError) => {
		const warehouse = makeWarehouseServiceStub({
			// SAFETY: the preview hands the stub plain compiled queries, never a capability compile.
			compiledQuery: ((_tenant: unknown, compiled: CompiledQueryInput<unknown>) => {
				const query = compiledQueryOf(compiled)
				return Str.includes("countIf")(query.sql)
					? Effect.fail(failure)
					: query.decodeRows([]).pipe(Effect.orDie)
			}) as never,
		})
		return Effect.gen(function* () {
			const service = yield* IngestRulePreviewService
			return yield* service.preview(tenant, spec, Date.UTC(2026, 10, 23, 12))
		}).pipe(
			Effect.flip,
			Effect.provide(
				Layer.effect(IngestRulePreviewService, IngestRulePreviewService.make).pipe(
					Layer.provide(Layer.succeed(WarehouseQueryService, warehouse)),
				),
			),
		)
	}

	it("answers a regex the warehouse cannot compile as an invalid rule, not a warehouse failure", async () => {
		const error = await Effect.runPromise(
			previewWith(
				new WarehouseQueryError({
					message: "Cannot compile re2",
					pipeName: "ingestRulePreviewLogs",
					clickhouseType: "CANNOT_COMPILE_REGEXP",
				}),
			),
		)
		expect(error._tag).toBe("@maple/http/errors/IngestRuleValidationError")
	})

	it("keeps any other warehouse failure as it is", async () => {
		const error = await Effect.runPromise(
			previewWith(new WarehouseQueryError({ message: "timeout", pipeName: "ingestRulePreviewLogs" })),
		)
		expect(error._tag).toBe("@maple/http/errors/WarehouseQueryError")
	})
})
