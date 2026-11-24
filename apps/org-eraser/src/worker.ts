/**
 * The org-eraser Worker: erases what deleted organizations left outside Postgres, from the
 * `org_erasures` outbox, on a cron. It serves no requests (no route, no workers.dev URL, every
 * fetch refused), because it alone holds the warehouse delete token and a delete-capable binding
 * to the replay bucket.
 */
import {
	MapleDb,
	mapleDbEnv,
	MapleStack,
	mapleWorkerProps,
	ReplayBlobs,
	SourceMapsBucket,
} from "@maple/infra/cloudflare"
import { cachedRecoverable } from "@maple/infra/cached-recoverable"
import { resolveWorkerEnv } from "@maple/infra/secret-guard"
import { WORKER_PURE_OPTIONS } from "@maple/infra/worker-build"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import { WorkerTelemetry } from "@maple/infra/worker-telemetry"
import { bindChatSessions } from "@maple/backend/platform/chat-sessions"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Cause, Config, Effect, Option } from "effect"
import { HttpServerResponse } from "effect/http"
import { orgEraserConfiguredEnv } from "./resources/env.ts"

/** Every ten minutes: a warehouse delete job is polled once per fire, so this sets the pace. */
export const ORG_ERASER_CRON = "*/10 * * * *"

const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const stack = yield* MapleStack
	const { stage, region, devEnv, db } = stack
	const env = yield* resolveWorkerEnv("org-eraser", orgEraserConfiguredEnv(stage, region))
	return {
		main: import.meta.url,
		...mapleWorkerProps("org-eraser", stack),
		workersDev: false,
		build: { pure: WORKER_PURE_OPTIONS },
		env: {
			// alerting's pool: both are background consumers, and this one is small.
			...mapleDbEnv(db, "alerting"),
			...env,
			...devEnv,
		},
	}
})

/** Production only: other stages share live org data, and erasing it is not theirs to do. */
const isProduction = (env: Record<string, unknown>) =>
	Config.option(Config.String("MAPLE_ENVIRONMENT")).pipe(
		Effect.map((environment) => Option.contains(environment, "production")),
		Effect.orElseSucceed(() => false),
		// The fire's env is the boundary this config belongs to.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(workerEnvLayer(env)),
	)

export default class OrgEraser extends Cloudflare.Worker<OrgEraser>()(
	"org-eraser",
	props,
	Effect.gen(function* () {
		// Lazy and recoverable: a rejected import retries on the next fire.
		const tick = yield* cachedRecoverable(Effect.promise(() => import("./tick")))
		yield* MapleDb
		// maple-ai's chat Durable Object, whose conversations are erased.
		const chatSessions = yield* bindChatSessions
		const replayBlobs = yield* Cloudflare.R2.ReadWriteBucket(ReplayBlobs)
		const sourceMaps = yield* Cloudflare.R2.ReadWriteBucket(SourceMapsBucket)

		const onFire = () =>
			Effect.gen(function* () {
				const env = yield* Cloudflare.WorkerEnvironment
				if (!(yield* isProduction(env))) return
				const { runTick } = yield* tick
				yield* runTick(env, chatSessions, replayBlobs, sourceMaps)
			}).pipe(
				// Interrupts are isolate teardown, not a failed run; the next fire picks up the rest.
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.void
						: Effect.logError("Org erasure run failed", cause),
				),
			)

		yield* Cloudflare.Workers.cron(ORG_ERASER_CRON, onFire)

		return { fetch: Effect.succeed(HttpServerResponse.empty({ status: 404 })) }
	}).pipe(
		// The init is the entry point: the cron source needs the host Worker.
		Effect.provide([
			Cloudflare.Hyperdrive.ConnectBinding,
			Cloudflare.R2.ReadWriteBucketBinding,
			Cloudflare.Workers.CronEventSourceLive,
			WorkerTelemetry({ serviceName: "org-eraser" }),
		]),
	),
) {}
