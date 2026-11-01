import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Effect, Option, Redacted, Schema } from "effect"
import { UserId } from "@maple/domain/http"
import { UptimeIntervalSeconds } from "@maple/domain/primitives"
import { UptimeCheckReportList, UptimeProbeTarget } from "@maple/domain/uptime"
import { Env } from "@maple/backend/platform/Env"
import { isValidInternalBearer } from "@maple/backend/services/auth/internal-auth"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { UptimeMonitorsService } from "@maple/backend/services/uptime/UptimeMonitorsService"

/** Audit identity for lazily-created ingest keys (org_ingest_keys.created_by). */
const UPTIME_SYSTEM_USER = Schema.decodeSync(UserId)("system-uptime-prober")
const decodeReportsEffect = Schema.decodeUnknownEffect(UptimeCheckReportList)
const decodeInterval = Schema.decodeUnknownOption(UptimeIntervalSeconds)
/** Heartbeat tokens are 24 url-safe characters; anything else is refused before a lookup. */
const HEARTBEAT_TOKEN = /^[A-Za-z0-9_-]{16,64}$/u
const NO_TARGETS: ReadonlyArray<UptimeProbeTarget> = []

const text = (body: string, status: number) =>
	HttpServerResponse.text(body, {
		status,
		headers: { "content-type": "text/plain; charset=utf-8" },
	})

/**
 * Internal endpoints backing the uptime prober in `apps/scraper`, behind the `SD_INTERNAL_TOKEN`
 * bearer: it polls `/api/internal/uptime-targets` for enabled http/tcp/dns monitors, runs the
 * checks, and reports outcomes to `/api/internal/uptime-results`.
 */
export const UptimeInternalRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const env = yield* Env
		const service = yield* UptimeMonitorsService
		const ingestKeys = yield* OrgIngestKeysService
		const internalToken = Option.match(env.SD_INTERNAL_TOKEN, {
			onNone: () => undefined,
			onSome: Redacted.value,
		})

		const unauthorized = (req: HttpServerRequest.HttpServerRequest) => {
			if (!internalToken) return text("Uptime internal endpoints are not configured", 401)
			if (!isValidInternalBearer(req.headers.authorization, internalToken))
				return text("Unauthorized", 401)
			return undefined
		}

		const listTargets = Effect.fn("UptimeInternal.listTargets")(
			function* (req: HttpServerRequest.HttpServerRequest) {
				const denied = unauthorized(req)
				if (denied) return denied

				const rows = yield* service.listProbeTargets()
				// Check spans go into each org's own traces, sent with its public ingest key.
				const keysByOrg = yield* ingestKeys.getOrCreateMany(
					rows.map((row) => row.orgId),
					UPTIME_SYSTEM_USER,
				)
				const perRow = yield* Effect.forEach(rows, (row) => {
					const keys = keysByOrg.get(row.orgId)
					const intervalSeconds = decodeInterval(row.intervalSeconds)
					if (keys === undefined || Option.isNone(intervalSeconds)) {
						return Effect.logWarning("Skipping uptime monitor").pipe(
							Effect.annotateLogs({
								monitorId: row.id,
								orgId: row.orgId,
								reason: keys === undefined ? "no ingest key" : "invalid interval",
							}),
							Effect.as(NO_TARGETS),
						)
					}
					return Effect.succeed([
						new UptimeProbeTarget({
							id: row.id,
							orgId: row.orgId,
							name: row.name,
							serviceName: row.serviceName,
							intervalSeconds: intervalSeconds.value,
							config: row.config,
							ingestKey: keys.publicKey,
						}),
					])
				})

				return yield* HttpServerResponse.json(perRow.flat())
			},
			Effect.catch((error) =>
				Effect.logError("Failed to build uptime target list").pipe(
					Effect.annotateLogs({ error: error.message }),
					Effect.as(text("Uptime target list unavailable", 503)),
				),
			),
		)

		const recordResults = (req: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				const denied = unauthorized(req)
				if (denied) return denied

				const body = yield* req.json.pipe(Effect.option)
				if (Option.isNone(body)) return text("Invalid JSON body", 400)

				const reports = yield* decodeReportsEffect(body.value).pipe(Effect.option)
				if (Option.isNone(reports)) return text("Invalid uptime results payload", 400)

				const applied = yield* service.recordChecks(reports.value)
				return yield* HttpServerResponse.json({ recorded: reports.value.length, applied })
			}).pipe(
				Effect.catch((error) =>
					Effect.logError("Failed to persist uptime results").pipe(
						Effect.annotateLogs({ error: error.message }),
						Effect.as(text("Uptime result persistence unavailable", 503)),
					),
				),
			)

		yield* router.add("GET", "/api/internal/uptime-targets", listTargets)
		yield* router.add("POST", "/api/internal/uptime-results", recordResults)
	}),
)

/**
 * Public heartbeat pings: `GET|POST /hb/<token>` reports success, `/hb/<token>/fail` a failure.
 * The token is the credential. A hot path: one indexed lookup, one update, no spans of its own.
 */
export const UptimeHeartbeatRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const service = yield* UptimeMonitorsService

		const ping = (ok: boolean) =>
			Effect.gen(function* () {
				const params = yield* HttpRouter.params
				const token = params.token
				if (token === undefined || !HEARTBEAT_TOKEN.test(token)) return text("Not found", 404)
				return yield* service.recordPing(token, ok).pipe(
					Effect.as(text("OK", 200)),
					Effect.catchTags({
						"@maple/backend/uptime/HeartbeatNotFound": () =>
							Effect.succeed(text("Not found", 404)),
						"@maple/http/errors/UptimeMonitorPersistenceError": (error) =>
							Effect.logError("Failed to record heartbeat").pipe(
								Effect.annotateLogs({ error: error.message }),
								Effect.as(text("Heartbeat unavailable", 503)),
							),
					}),
				)
			})

		yield* router.add("GET", "/hb/:token", ping(true))
		yield* router.add("POST", "/hb/:token", ping(true))
		yield* router.add("GET", "/hb/:token/fail", ping(false))
		yield* router.add("POST", "/hb/:token/fail", ping(false))
	}),
)
