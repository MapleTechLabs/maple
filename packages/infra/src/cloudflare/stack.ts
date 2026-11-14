import * as Cloudflare from "@alchemy.run/cloudflare"
import type * as Output from "alchemy/Output"
import * as Context from "effect/Context"
import type * as Redacted from "effect/Redacted"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { WorkerDev } from "@maple/alchemy-portless"
import { type DevApp, isDevApp } from "../dev-urls.ts"
import { WORKER_COMPATIBILITY_DATE } from "./worker-build.ts"
import { Stage } from "alchemy/Stage"
import type { MapleProfile } from "../profile.ts"
import type { MapleRegion } from "../region.ts"
import {
	type MapleDbConsumer,
	type MapleDeployment,
	type MapleDomains,
	type MapleStage,
	parseMapleDeploymentEffect,
	resolveWorkerName,
	resolveWorkerPlacement,
} from "./stage.ts"

/** A Postgres login for an ECS service. A changed `id` rolls the tasks before the old login goes. */
export interface MapleDbLogin {
	readonly id: Output.Output<string>
	readonly url: Output.Output<Redacted.Redacted>
}

/**
 * A deploy-declared database (PlanetScale on prd, Neon on previews): the migrated branch, the
 * Hyperdrive config each consumer binds as `MAPLE_DB` (US prd: lookups of its dashboard configs), and the ECS logins.
 */
export interface MapleDbResources {
	/** The branch's name. As Worker env it orders the upload after the migrations. */
	readonly branch: Output.Output<string>
	readonly hyperdrives: Record<MapleDbConsumer, Cloudflare.Hyperdrive.Connection> | undefined
	/** The ingest gateway's pooled login. */
	readonly ingest: MapleDbLogin
	/** Electric's direct replication login, where the profile deploys Electric. */
	readonly electric: MapleDbLogin | undefined
}

/** Inter-app public origins as plan-time strings (custom domains, portless routes, or env). */
export interface MapleUrls {
	readonly api: string
	readonly ingest: string
	readonly electricSync: string
	/** The status Worker's origin; empty where it has no domain (prd until one is bought). */
	readonly status: string
}

export interface MapleStackContext {
	readonly stage: MapleStage
	/** The instance this deploy belongs to; `us` unless the stage string says `-eu`. */
	readonly region: MapleRegion
	readonly domains: MapleDomains
	/** What this deployment runs and how big (`resolveMapleProfile`). */
	readonly profile: MapleProfile
	readonly urls: MapleUrls
	/** A Worker's `dev` block under `bun dev` (served, or left `external`); undefined on a deploy. */
	readonly workerDev: (app: DevApp) => WorkerDev | undefined
	/** Inter-app URLs under `bun dev`, spread last so `.env.local` cannot override them. */
	readonly devEnv: Record<string, string> | undefined
	/** The declared database (prd and previews); undefined on dev. */
	readonly db: MapleDbResources | undefined
}

/** The deploy context Worker props read. Plan-time only: read behind `__ALCHEMY_RUNTIME__`. */
export class MapleStack extends Context.Service<MapleStack, MapleStackContext>()("@maple/infra/MapleStack") {}

/**
 * The deployed api Worker, for web's `API` binding. Not a `Worker.ref`: that reads stored
 * state and cannot see a sibling created by the same deploy.
 */
export class ApiWorker extends Context.Service<ApiWorker, Cloudflare.Worker>()("@maple/infra/ApiWorker") {}

/** The deployed sandbox Worker, for maple-ai's binding (see {@link ApiWorker}). */
export class SandboxWorker extends Context.Service<SandboxWorker, Cloudflare.Worker>()(
	"@maple/infra/SandboxWorker",
) {}

/** The deployed AI Worker, for api's binding that forwards `/mcp` and chat (see {@link ApiWorker}). */
export class AiWorker extends Context.Service<AiWorker, Cloudflare.Worker>()("@maple/infra/AiWorker") {}

/**
 * This deploy's stage and region, read off alchemy's `Stage` (yieldable from a Worker init). The
 * root stack already failed typed on a bad stage, so here it is a defect.
 */
export const stageDeployment: Effect.Effect<MapleDeployment, never, Stage> = Effect.gen(function* () {
	const stage = yield* Stage
	return yield* parseMapleDeploymentEffect(stage)
}).pipe(Effect.orDie)

/**
 * A binding attached on prd alone, yielded from a Worker init: other stages run the same crons
 * and agents against live data. In the isolate `read` turns what is on the env into the client.
 */
export const prdOnlyBinding = <C, A, E, R, E2, R2>(
	bind: Effect.Effect<C, E, R>,
	read: (client: C) => Effect.Effect<Option.Option<A>, E2, R2>,
) =>
	Effect.gen(function* () {
		if (!globalThis.__ALCHEMY_RUNTIME__ && (yield* stageDeployment).stage.kind !== "prd") {
			return Option.none<A>()
		}
		const client = yield* bind
		if (!globalThis.__ALCHEMY_RUNTIME__) return Option.none<A>()
		return yield* read(client)
	})

/**
 * Props for a module-scope resource with a stage-derived name. Reads alchemy's `Stage` (not
 * `MapleStack`) so it can be yielded from a Worker init too; returns `{}` under `__ALCHEMY_RUNTIME__`.
 */
export const stageProps = <Props extends object>(
	base: string,
	make: (name: string, deployment: MapleDeployment) => Props,
): Effect.Effect<Partial<Props>, never, Stage> =>
	Effect.gen(function* () {
		if (globalThis.__ALCHEMY_RUNTIME__) return {}
		const deployment = yield* stageDeployment
		return make(resolveWorkerName(base, deployment.stage, deployment.region), deployment)
	})

/** {@link stageProps} for the common case: a resource whose only stage-derived prop is `name`. */
export const stageNamed = (base: string) => stageProps(base, (name) => ({ name }))

export { WORKER_COMPATIBILITY_DATE }

/**
 * The physical name and placement every Maple Worker, Website ones included, shares. `app` is
 * also the name base, so it must match the Worker's existing name.
 */
export const mapleSiteProps = (
	app: string,
	{ stage, region }: Pick<MapleStackContext, "stage" | "region">,
) => ({
	name: resolveWorkerName(app, stage, region),
	placement: resolveWorkerPlacement(region),
})

/** {@link mapleSiteProps} plus the compatibility date and the `bun dev` block of a Worker module. */
export const mapleWorkerProps = (app: string, stack: MapleStackContext) => ({
	...mapleSiteProps(app, stack),
	compatibility: { date: WORKER_COMPATIBILITY_DATE },
	...(isDevApp(app) && { dev: stack.workerDev(app) }),
})
