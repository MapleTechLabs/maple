/**
 * The electric-sync Worker: an ElectricSQL shape proxy, deliberately DB-free. It
 * authenticates the session bearer, pins each shape's org scope and forwards.
 */
import {
	cachedRecoverable,
	MapleStack,
	type MapleRegion,
	type MapleStage,
	resolveWorkerName,
	resolveWorkerPlacement,
} from "@maple/infra/cloudflare"
import { authEnv, merge, optionalPlain, optionalSecret, selfObservabilityEnv } from "@maple/infra/env"
import { WorkerTelemetry } from "@maple/infra/worker-telemetry"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer, Scope } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/http"

const configuredEnv = (stage: MapleStage, region: MapleRegion) =>
	merge(
		authEnv,
		optionalPlain("MAPLE_ORG_ID_OVERRIDE"),
		// PR previews get no Electric config: shared `dev` credentials would serve another
		// stage's data. Unset ELECTRIC_URL means 503 and the web app falls back to fetches.
		...(stage.kind === "pr"
			? []
			: [
					optionalPlain("ELECTRIC_URL"),
					optionalPlain("ELECTRIC_SOURCE_ID"),
					optionalSecret("ELECTRIC_SECRET"),
				]),
		selfObservabilityEnv(stage, region),
	)

/** `__ALCHEMY_RUNTIME__` folds to `true` in the bundle, so the stack-side branch is tree-shaken. */
const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const { stage, region, domains, workerDev } = yield* MapleStack
	return {
		main: import.meta.url,
		name: resolveWorkerName("electric-sync", stage, region),
		compatibility: { date: "2026-10-01" },
		placement: resolveWorkerPlacement(region),
		dev: workerDev("electric-sync"),
		workersDev: true,
		// Custom domain, not a zone route: routes create no DNS, so pr hosts would NXDOMAIN.
		domain: domains.sync,
		env: yield* configuredEnv(stage, region),
	}
})

// Dynamic imports keep the route graph's Schema ASTs out of the startup-CPU budget.
const AppLayer = Layer.unwrap(
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
				Layer.provideMerge(
					HttpRouter.cors({
						allowedOrigins: ["*"],
						allowedMethods: ["GET", "OPTIONS"],
						allowedHeaders: ["*"],
						// Required: without them the Electric client stalls after the first chunk.
						exposedHeaders: [
							"electric-handle",
							"electric-offset",
							"electric-schema",
							"electric-cursor",
							"electric-up-to-date",
						],
					}),
				),
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
				return yield* HttpRouter.toHttpEffect(AppLayer).pipe(Scope.provide(scope))
			}).pipe(Effect.orDie),
		)

		return { fetch: app }
	}).pipe(
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(WorkerTelemetry({ serviceName: "electric-sync" })),
	),
) {}
