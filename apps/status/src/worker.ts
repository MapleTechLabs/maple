/**
 * The status Worker: serves customer status pages from edge storage alone (KV, R2, the colo
 * cache), so a page keeps its last known state while every other part of Maple is down. Custom
 * domains reach it through a Worker route per hostname (docs/status-page-custom-domains.md).
 * No Hyperdrive, and serving never calls Maple: the one service binding, `API`, carries only the
 * subscribe, confirm and unsubscribe forms. Traces export to Maple's ingest after the response,
 * best effort, so an outage loses them without touching the page.
 */
import {
	ApiWorker,
	MapleStack,
	mapleWorkerProps,
	StatusSnapshotsBucket,
	StatusSnapshotsKv,
} from "@maple/infra/cloudflare"
import { selfObservabilityEnv } from "@maple/infra/env"
import { dischargeRuntimeContext } from "@maple/infra/worker-runtime"
import { WorkerTelemetry } from "@maple/infra/worker-telemetry"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as AlchemyTelemetry from "alchemy/Telemetry"
import { Clock, Effect, Layer, Option } from "effect"
import * as SecureRandom from "effect/crypto/SecureRandom"
import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from "effect/http"
import { handleRequest, sharedHostMatcher } from "./handler"
import { nativeStorage } from "./storage"
import { apiSubscriptions } from "./subscribe"

const isFetcher = (value: unknown): value is Fetcher =>
	typeof value === "object" && value !== null && "fetch" in value && typeof value.fetch === "function"

// The auto server span stamps `url.full` verbatim, and these links carry a confirmation or
// unsubscribe token in the query; the handler's own `status.request` span records no URL.
const TOKEN_LINK_PATH = /\/(?:subscribe\/confirm|unsubscribe)(?:\?|$)/u

/** `__ALCHEMY_RUNTIME__` folds to `true` in the bundle, so the stack-side branch is tree-shaken. */
const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const stack = yield* MapleStack
	const env = yield* selfObservabilityEnv(stack.stage, stack.region)
	return {
		main: import.meta.url,
		...mapleWorkerProps("status", stack),
		// The status domain serves `/s/<slug>`; every other host but workers.dev is a custom domain.
		env: {
			...env,
			API: yield* ApiWorker,
			...(stack.domains.status === undefined ? undefined : { MAPLE_STATUS_HOST: stack.domains.status }),
		},
		// Pages are served at `/s/<slug>`; previews get a domain, prd stays on workers.dev until it has one.
		domain: stack.domains.status,
		workersDev: true,
	}
})

export default class StatusWorker extends Cloudflare.Worker<StatusWorker>()(
	"status",
	props,
	Effect.gen(function* () {
		// Read-write only for the break-glass overlay; snapshots are the publisher's to write.
		const kv = yield* Cloudflare.KV.ReadWriteNamespace(StatusSnapshotsKv)
		const bucket = yield* Cloudflare.R2.ReadBucket(StatusSnapshotsBucket)
		const limiter = yield* Cloudflare.RateLimit("STATUS_BREAK_GLASS_RATE_LIMITER", {
			namespaceId: 2026102801,
			simple: { limit: 10, period: 60 },
		})

		return {
			fetch: Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest
				const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie)
				const [kvBinding, bucketBinding, limiterBinding] = yield* dischargeRuntimeContext(
					Effect.all([kv.raw, bucket.raw, limiter.raw]),
				)
				const storage = nativeStorage({
					kv: kvBinding,
					bucket: bucketBinding,
					limiter: limiterBinding,
					cache: caches.open("status-snapshots"),
				})
				const nowMs = yield* Clock.currentTimeMillis
				const workerEnv = yield* Cloudflare.WorkerEnvironment
				const response = yield* handleRequest(web, {
					storage,
					subscriptions: apiSubscriptions(Option.liftPredicate(workerEnv.API, isFetcher)),
					nowMs,
					randomId: () => SecureRandom.uuidV4Unsafe(),
					isSharedHost: sharedHostMatcher(
						typeof workerEnv.MAPLE_STATUS_HOST === "string" ? workerEnv.MAPLE_STATUS_HOST : null,
					),
				})
				yield* Effect.annotateCurrentSpan("http.response.status_code", response.status)
				return HttpServerResponse.fromWeb(response)
			}).pipe(Effect.withSpan("status.request")),
		}
	}).pipe(
		Effect.provide([
			Cloudflare.KV.ReadWriteNamespaceBinding,
			Cloudflare.R2.ReadBucketBinding,
			Cloudflare.Workers.RateLimitBinding,
			WorkerTelemetry({ serviceName: "status" }),
			AlchemyTelemetry.layer(
				Layer.succeed(HttpMiddleware.TracerDisabledWhen, (request: { url: string }) =>
					TOKEN_LINK_PATH.test(request.url),
				),
			),
		]),
	),
) {}
