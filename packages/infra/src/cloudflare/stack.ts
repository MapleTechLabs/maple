import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type { WorkerDev } from "@maple/alchemy-portless"
import type { DevApp } from "../dev-urls.ts"
import { Stage } from "alchemy/Stage"
import { type MapleDomains, type MapleStage, parseMapleStage, resolveWorkerName } from "./stage.ts"

/**
 * Public origins of the apps the others point at, as plan-time strings:
 * custom domains on deployed stages, portless routes under `bun dev`,
 * env-supplied (or empty) on a cloud-deployed dev stage.
 */
export interface MapleUrls {
	readonly api: string
	readonly ingest: string
	readonly electricSync: string
}

export interface MapleStackContext {
	readonly stage: MapleStage
	readonly domains: MapleDomains
	readonly urls: MapleUrls
	/** A Worker's `dev` block under `bun dev` (served, or left `external`); undefined on a deploy. */
	readonly workerDev: (app: DevApp) => WorkerDev | undefined
	/**
	 * Inter-app URLs handed to the Workers as env under `bun dev`, spread last
	 * so `.env.local` cannot override them; undefined on a deploy.
	 */
	readonly devEnv: Record<string, string> | undefined
}

/**
 * What the stack tells a single-module Worker (`main: import.meta.url`) about
 * the deploy it belongs to. The Worker's props Effect yields it; the root stack
 * provides it once, from `Alchemy.Stage`. Plan-time only: a Worker reads it
 * behind its `__ALCHEMY_RUNTIME__` guard, so it never has to exist in an isolate.
 */
export class MapleStack extends Context.Service<MapleStack, MapleStackContext>()("@maple/infra/MapleStack") {}

/**
 * Props for a resource declared at module scope whose physical name is
 * stage-derived (`resolveWorkerName(base, stage)`): `make` receives that name
 * and returns the props. Reads alchemy's own `Stage` — one of the platform
 * services a Worker's init may require, unlike `MapleStack` — so the
 * declaration can be yielded from the init as well as from the props. Alchemy
 * evaluates a resource's props Effect wherever the resource is yielded — the
 * deployed bundle included, where it is inert — so, like a Worker's props,
 * this returns nothing under `__ALCHEMY_RUNTIME__` and the stage read is
 * dead-code-eliminated from what ships.
 */
export const stageProps = <Props extends object>(
	base: string,
	make: (name: string) => Props,
): Effect.Effect<Partial<Props>, never, Stage> =>
	Effect.gen(function* () {
		if (globalThis.__ALCHEMY_RUNTIME__) return {}
		const stage = parseMapleStage(yield* Stage)
		return make(resolveWorkerName(base, stage))
	})

/** {@link stageProps} for the common case: a resource whose only stage-derived prop is `name`. */
export const stageNamed = (base: string) => stageProps(base, (name) => ({ name }))
