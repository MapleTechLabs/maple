import { DemoSeedError, DemoSeedResponse, type OrgId, type UserId } from "@maple/domain/http"
import { Context, Effect, Layer } from "effect"
import { Env } from "../lib/Env"
import { OrgIngestKeysService } from "./OrgIngestKeysService"
import { generateDemoBatches } from "./demo/fixtures"

const DEMO_HOURS_DEFAULT = 6
const DEMO_RATE_PER_HOUR = 250

const toSeedError = (message: string) => new DemoSeedError({ message })

export class DemoService extends Context.Service<DemoService>()("@maple/api/services/DemoService", {
	make: Effect.gen(function* () {
		const ingestKeys = yield* OrgIngestKeysService
		const env = yield* Env
		const ingestBaseUrl = env.MAPLE_INGEST_PUBLIC_URL.replace(/\/$/, "")

		const postOtlp = (path: string, body: unknown, ingestKey: string) =>
			Effect.tryPromise({
				try: async () => {
					const response = await fetch(`${ingestBaseUrl}${path}`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${ingestKey}`,
						},
						body: JSON.stringify(body),
					})
					if (!response.ok) {
						const text = await response.text().catch(() => "")
						throw new Error(`Ingest gateway ${response.status}: ${text.slice(0, 200)}`)
					}
				},
				catch: (error) =>
					toSeedError(
						error instanceof Error ? error.message : "Failed to forward demo data to ingest",
					),
			})

		const seed = Effect.fn("DemoService.seed")(function* (
			orgId: OrgId,
			userId: UserId,
			hours: number = DEMO_HOURS_DEFAULT,
		) {
			const keys = yield* ingestKeys
				.getOrCreate(orgId, userId)
				.pipe(Effect.mapError((error) => toSeedError(error.message)))

			const safeHours = Math.max(1, Math.min(24, Math.floor(hours)))
			const { tracesByBatch, logsByBatch } = generateDemoBatches({
				hours: safeHours,
				ratePerHour: DEMO_RATE_PER_HOUR,
			})

			yield* Effect.forEach(
				tracesByBatch,
				(batch) => postOtlp("/v1/traces", { resourceSpans: batch }, keys.publicKey),
				{ concurrency: 1, discard: true },
			)
			const spansSent = tracesByBatch.reduce(
				(total, batch) =>
					total +
					batch.reduce((acc, rs) => acc + rs.scopeSpans.reduce((s, sc) => s + sc.spans.length, 0), 0),
				0,
			)

			yield* Effect.forEach(
				logsByBatch,
				(batch) => postOtlp("/v1/logs", { resourceLogs: batch }, keys.publicKey),
				{ concurrency: 1, discard: true },
			)
			const logsSent = logsByBatch.reduce(
				(total, batch) =>
					total +
					batch.reduce(
						(acc, rl) => acc + rl.scopeLogs.reduce((s, sc) => s + sc.logRecords.length, 0),
						0,
					),
				0,
			)

			return new DemoSeedResponse({
				seeded: true,
				skippedReason: null,
				spansSent,
				logsSent,
				metricsSent: 0,
			})
		})

		return { seed }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
