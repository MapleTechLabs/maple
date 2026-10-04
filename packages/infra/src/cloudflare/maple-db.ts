/**
 * The `MAPLE_DB` Hyperdrive binding per the profile's database mode: `managed` and `ref` bind from the
 * Worker init (`ref` via raw `host.bind`, as alchemy has no `env` form for an external config);
 * `declared` binds from props via `mapleDbEnv`; `none` binds nothing.
 */
import * as Cloudflare from "alchemy/Cloudflare"
import { Stage } from "alchemy/Stage"
import * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { requiredPlain } from "../env.ts"
import { resolveMapleProfile } from "../profile.ts"
import type { MapleDbResources } from "./stack.ts"
import {
	type MapleDbConsumer,
	parseMapleDeploymentEffect,
	resolveHyperdriveRefId,
	resolveWorkerName,
} from "./stage.ts"

/** The binding's name — also the managed Connection's logical id, so both flavors bind under it. */
export const MAPLE_DB_BINDING = "MAPLE_DB"

/** This deploy's stage; the root stack already failed typed on a bad one, so here it is a defect. */
const stageDeployment = Effect.gen(function* () {
	return yield* parseMapleDeploymentEffect(yield* Stage)
}).pipe(Effect.orDie)

/**
 * Dev stages' managed Hyperdrive, origin from `MAPLE_PG_URL`. The root yields it first so that
 * read happens outside a Worker init (where alchemy would bind it as a secret). Plan-time only.
 */
export const ManagedMapleDb = Cloudflare.Hyperdrive.Connection(
	MAPLE_DB_BINDING,
	Effect.gen(function* () {
		const { stage, region } = yield* stageDeployment
		// A dev stage without its database URL cannot be planned: a defect, not a branch.
		const rawPgUrl = yield* Effect.orDie(requiredPlain("MAPLE_PG_URL"))
		const pgUrl = yield* Effect.try(() => new URL(rawPgUrl)).pipe(Effect.orDie)
		const props: Cloudflare.Hyperdrive.Props = {
			name: resolveWorkerName("db", stage, region),
			origin: {
				scheme: "postgres",
				host: pgUrl.hostname,
				port: Number(pgUrl.port || "5432"),
				// Connect-time db, not the PlanetScale resource name.
				database: pgUrl.pathname.replace(/^\//, "") || "postgres",
				user: decodeURIComponent(pgUrl.username),
				password: Redacted.make(decodeURIComponent(pgUrl.password)),
			},
			// Read-after-write everywhere (alert state CAS, dashboard versioning).
			caching: { disabled: true },
			dev: {
				scheme: "postgres",
				host: "localhost",
				port: 5499,
				database: "maple",
				user: "maple",
				password: Redacted.make("maple"),
				// Docker Postgres has no TLS; alchemy's default `prefer` stalls until timeout.
				sslmode: "disable",
			},
		}
		return props
	}),
)

/**
 * A Worker's env for prd's database. `MAPLE_DB_BRANCH` orders the upload after migrations (an
 * id-bound config gives alchemy no edge); on `"declared"` also the consumer's `MAPLE_DB`.
 */
export const mapleDbEnv = (db: MapleDbResources | undefined, consumer: MapleDbConsumer) =>
	db && {
		MAPLE_DB_BRANCH: db.schema.name,
		...(db.hyperdrives && { [MAPLE_DB_BINDING]: db.hyperdrives[consumer] }),
	}

/**
 * Bind `MAPLE_DB` from a Worker init (or a Workflow's outer phase; bindings are keyed by name).
 * Plan-time only. Needs `Cloudflare.Hyperdrive.ConnectBinding` on the init.
 */
export const MapleDb = (consumer: MapleDbConsumer) =>
	Effect.gen(function* () {
		if (globalThis.__ALCHEMY_RUNTIME__) return
		const deployment = yield* stageDeployment
		const { stage } = deployment
		switch (resolveMapleProfile(deployment).database) {
			case "managed": {
				yield* Cloudflare.Hyperdrive.Connect(ManagedMapleDb)
				return
			}
			case "ref": {
				const id = resolveHyperdriveRefId(stage, consumer)
				if (id === undefined) return
				const host = yield* Cloudflare.Worker
				yield* host.bind(MAPLE_DB_BINDING, {
					bindings: [{ type: "hyperdrive", name: MAPLE_DB_BINDING, id }],
				})
				return
			}
			// Bound from the Worker's props (`mapleDbEnv`), or not at all.
			case "declared":
			case "none":
				return
		}
	})

/** What a Worker reads off the `MAPLE_DB` binding: the runtime `Hyperdrive` object's connection facts. */
const MapleDbBinding = Schema.Struct({
	connectionString: Schema.String.check(Schema.isNonEmpty()),
	host: Schema.String,
	port: Schema.Number,
	database: Schema.String,
})
export type MapleDbBinding = typeof MapleDbBinding.Type

/** The `MAPLE_DB` binding off a Worker env, or `None` when absent or not a Hyperdrive object. */
export const readMapleDbBinding = (env: Record<string, unknown>): Option.Option<MapleDbBinding> =>
	Schema.decodeUnknownOption(MapleDbBinding)(env[MAPLE_DB_BINDING])
