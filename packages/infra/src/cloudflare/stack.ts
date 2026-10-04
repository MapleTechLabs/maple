import * as Cloudflare from "alchemy/Cloudflare"
import type * as Planetscale from "alchemy/Planetscale"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type { WorkerDev } from "@maple/alchemy-portless"
import { type DevApp, isDevApp } from "../dev-urls.ts"
import { Stage } from "alchemy/Stage"
import type { MapleProfile } from "../profile.ts"
import type { MapleRegion } from "../region.ts"
import {
	type MapleDbConsumer,
	type MapleDeployment,
	type MapleDomains,
	type MapleStage,
	parseMapleDeployment,
	resolveWorkerName,
	resolveWorkerPlacement,
} from "./stage.ts"

/**
 * prd's database: the branch whose deploy applies the migrations, and on a `"declared"`
 * instance the Hyperdrive config each consumer binds as `MAPLE_DB`.
 */
export interface MapleDbResources {
	readonly schema: Planetscale.PostgresBranch
	readonly hyperdrives: Record<MapleDbConsumer, Cloudflare.Hyperdrive.Connection> | undefined
}

/** Inter-app public origins as plan-time strings (custom domains, portless routes, or env). */
export interface MapleUrls {
	readonly api: string
	readonly ingest: string
	readonly electricSync: string
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
	/** prd's database resources; undefined on the other stages. */
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
 * Props for a module-scope resource with a stage-derived name. Reads alchemy's `Stage` (not
 * `MapleStack`) so it can be yielded from a Worker init too; returns `{}` under `__ALCHEMY_RUNTIME__`.
 */
export const stageProps = <Props extends object>(
	base: string,
	make: (name: string, deployment: MapleDeployment) => Props,
): Effect.Effect<Partial<Props>, never, Stage> =>
	Effect.gen(function* () {
		if (globalThis.__ALCHEMY_RUNTIME__) return {}
		const deployment = parseMapleDeployment(yield* Stage)
		return make(resolveWorkerName(base, deployment.stage, deployment.region), deployment)
	})

/** {@link stageProps} for the common case: a resource whose only stage-derived prop is `name`. */
export const stageNamed = (base: string) => stageProps(base, (name) => ({ name }))

/** Workers runtime compatibility date for every Maple Worker. */
export const WORKER_COMPATIBILITY_DATE = "2026-10-01"

/**
 * The props every Maple Worker shares: its physical name, compatibility date, placement and
 * `bun dev` block. `app` is also the name base, so it must match the Worker's existing name.
 */
export const mapleWorkerProps = (app: string, { stage, region, workerDev }: MapleStackContext) => ({
	name: resolveWorkerName(app, stage, region),
	compatibility: { date: WORKER_COMPATIBILITY_DATE },
	placement: resolveWorkerPlacement(region),
	...(isDevApp(app) && { dev: workerDev(app) }),
})

/**
 * maple-ai's `ChatSession` Durable Object, bound by class name from another Worker. By name,
 * not by ai's output, so the binder's deploy does not wait on ai's.
 */
export const chatSessionBinding = ({ stage, region }: MapleDeployment) =>
	Cloudflare.DurableObject("ChatSession", {
		className: "ChatSession",
		scriptName: resolveWorkerName("ai", stage, region),
	})
