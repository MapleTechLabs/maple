/**
 * The electric-sync Worker: an ElectricSQL shape proxy, deliberately DB-free. It
 * authenticates the session bearer, pins each shape's org scope and forwards.
 */
import {
	cachedRecoverable,
	type MapleDomains,
	type MapleRegion,
	MapleStack,
	type MapleStage,
	mapleWorkerProps,
} from "@maple/infra/cloudflare"
import {
	authEnv,
	derived,
	merge,
	optionalPlain,
	optionalSecret,
	selfObservabilityEnv,
} from "@maple/infra/env"
import { WorkerTelemetry } from "@maple/infra/worker-telemetry"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer, Scope } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/http"
import { ELECTRIC_SYNC_CORS_OPTIONS } from "./routes/cors"

const configuredEnv = (stage: MapleStage, region: MapleRegion, domains: MapleDomains) =>
	merge(
		authEnv,
		optionalPlain("MAPLE_ORG_ID_OVERRIDE"),
		// A preview proxies its own Electric, never the shared `dev` one (another stage's data).
		stage.kind === "pr" && domains.electric
			? derived("ELECTRIC_URL", `https://${domains.electric}`)
			: merge(optionalPlain("ELECTRIC_URL"), optionalPlain("ELECTRIC_SOURCE_ID")),
		optionalSecret("ELECTRIC_SECRET"),
		selfObservabilityEnv(stage, region),
	)

/** `__ALCHEMY_RUNTIME__` folds to `true` in the bundle, so the stack-side branch is tree-shaken. */
const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const stack = yield* MapleStack
	const { stage, region, domains } = stack
	return {
		main: import.meta.url,
		...mapleWorkerProps("electric-sync", stack),
		workersDev: true,
		// Custom domain, not a zone route: routes create no DNS, so pr hosts would NXDOMAIN.
		domain: domains.sync,
		env: yield* configuredEnv(stage, region, domains),
	}
})

// Dynamic imports keep the route graph's Schema ASTs out of the startup-CPU budget.
const AppLive = Layer.unwrap(
	Effect.all(
		[
			Effect.promise(() => import("./routes/shape.http")),
			Effect.promise(() => import("./electric/ElectricClient")),
			Effect.promise(() => import("./auth/TenantResolver")),
			Effect.promise(() => import("./config")),
		],
		{ concurrency: "unbounded" },
	).pipe(
		Effect.map(([{ ElectricSyncRouter }, { ElectricClient }, { TenantResolver }, { SyncConfig }]) =>
			ElectricSyncRouter.pipe(
				Layer.provideMerge(HttpRouter.cors(ELECTRIC_SYNC_CORS_OPTIONS)),
				// The only place the real implementations are wired; tests substitute them.
				Layer.provideMerge(ElectricClient.layer.pipe(Layer.provide(FetchHttpClient.layer))),
				Layer.provideMerge(TenantResolver.layer),
				Layer.provideMerge(SyncConfig.layer),
				Layer.provideMerge(HttpRouter.layer),
			),
		),
	),
)

export default class ElectricSync extends Cloudflare.Worker<ElectricSync>()(
	"electric-sync",
	props,
	Effect.gen(function* () {
		// Built on the first request, not in init (plan time would auto-bind every `Config`).
		// The scope is never closed, so the layer must stay value-shaped. A failed build
		// answers 500 and the next request rebuilds.
		const app = yield* cachedRecoverable(
			Effect.gen(function* () {
				const scope = yield* Scope.make()
				return yield* HttpRouter.toHttpEffect(AppLive).pipe(Scope.provide(scope))
			}).pipe(Effect.orDie),
		)

		return { fetch: app }
	}).pipe(
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(WorkerTelemetry({ serviceName: "electric-sync" })),
	),
) {}
