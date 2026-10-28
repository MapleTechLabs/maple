/**
 * The status Worker: serves customer status pages from edge storage alone (KV, R2, the colo
 * cache), so a page keeps its last known state while every other part of Maple is down.
 * No service bindings, Hyperdrive or telemetry export: nothing here may call back into Maple.
 */
import { MapleStack, mapleWorkerProps } from "@maple/infra/cloudflare"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import { Clock, Effect, Layer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { handleRequest } from "./handler"
import { StatusSnapshotsBucket, StatusSnapshotsKv } from "./resources"
import { nativeStorage } from "./storage"

/** `__ALCHEMY_RUNTIME__` folds to `true` in the bundle, so the stack-side branch is tree-shaken. */
const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const stack = yield* MapleStack
	return {
		main: import.meta.url,
		...mapleWorkerProps("status", stack),
		// Pages are reachable at `/s/<slug>` here; CF for SaaS custom hostnames will attach in a later PR.
		workersDev: true,
	}
})

/** Discharge alchemy's phantom color, the way alchemy's own runtime helpers do. */
const runtime = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>): Effect.Effect<A, E> =>
	// oxlint-disable-next-line effecttsgo/strict-effect-provide
	Effect.provide(effect, RuntimeContext.phantom)

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
				const [kvBinding, bucketBinding, limiterBinding] = yield* runtime(
					Effect.all([kv.raw, bucket.raw, limiter.raw]),
				)
				const storage = nativeStorage({
					kv: kvBinding,
					bucket: bucketBinding,
					limiter: limiterBinding,
					cache: caches.open("status-snapshots"),
				})
				const nowMs = yield* Clock.currentTimeMillis
				const response = yield* handleRequest(web, {
					storage,
					nowMs,
					randomId: () => crypto.randomUUID(),
				})
				return HttpServerResponse.fromWeb(response)
			}),
		}
	}).pipe(
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(
			Layer.mergeAll(
				Cloudflare.KV.ReadWriteNamespaceBinding,
				Cloudflare.R2.ReadBucketBinding,
				Cloudflare.Workers.RateLimitBinding,
			),
		),
	),
) {}
