/**
 * The application database as the `MAPLE_DB` Hyperdrive binding, in the one
 * shape `resolveDatabaseMode` picks for the stage — bound from the Worker's own
 * init, the way alchemy's `Hyperdrive.ConnectBinding` binds its resource:
 *
 * - `"managed"` (dev stages): `ManagedMapleDb`, the alchemy-managed Hyperdrive
 *   below, bound through `Hyperdrive.Connect`.
 * - `"ref"` (stg/prd): a dashboard-managed config, attached by id. Alchemy has
 *   no `env` form for a Hyperdrive it did not create; its own `ConnectBinding`
 *   attaches the same raw metadata with `host.bind`, so this does too. The
 *   origin and credentials live only in the Cloudflare dashboard.
 * - `"none"` (PR previews): no binding at all; the Worker still boots and
 *   DB-backed routes 500 while everything else works.
 *
 * `readMapleDbBinding` is the runtime side: what a Worker (or a Workflow run)
 * reads off its env under the same name, on every stage.
 */
import * as Cloudflare from "alchemy/Cloudflare"
import { Stage } from "alchemy/Stage"
import * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { requiredPlain } from "../env.ts"
import {
	type MapleDbConsumer,
	parseMapleStage,
	resolveDatabaseMode,
	resolveHyperdriveRefId,
	resolveWorkerName,
} from "./stage.ts"

/** The binding's name — also the managed Connection's logical id, so both flavors bind under it. */
export const MAPLE_DB_BINDING = "MAPLE_DB"

/**
 * The alchemy-managed Hyperdrive of dev stages, origin parsed from
 * `MAPLE_PG_URL` (Hyperdrive wants a structured origin). Declared once here;
 * the root stack yields it first on managed stages so the `MAPLE_PG_URL` read
 * happens outside a Worker init, where alchemy's plan-time ConfigProvider
 * would bind every `Config` it sees onto the Worker as a secret. Plan-time
 * only: `MapleDb` yields it behind the runtime guard, so these props never run
 * in the bundle and need no guard of their own.
 */
export const ManagedMapleDb = Cloudflare.Hyperdrive.Connection(
	MAPLE_DB_BINDING,
	Effect.gen(function* () {
		const stage = parseMapleStage(yield* Stage)
		// A dev stage without its database URL cannot be planned: a defect, not a branch.
		const pgUrl = new URL(yield* Effect.orDie(requiredPlain("MAPLE_PG_URL")))
		const props: Cloudflare.Hyperdrive.Props = {
			name: resolveWorkerName("db", stage),
			origin: {
				scheme: "postgres",
				host: pgUrl.hostname,
				port: Number(pgUrl.port || "5432"),
				// Connect-time db (`postgres`, the PlanetScale cluster default),
				// not the PS resource name.
				database: pgUrl.pathname.replace(/^\//, "") || "postgres",
				user: decodeURIComponent(pgUrl.username),
				password: Redacted.make(decodeURIComponent(pgUrl.password)),
			},
			// Read-after-write everywhere (alert state CAS, dashboard versioning) —
			// revisit caching once read paths that tolerate staleness are identified.
			caching: { disabled: true },
			dev: {
				scheme: "postgres",
				host: "localhost",
				port: 5499,
				database: "maple",
				user: "maple",
				password: Redacted.make("maple"),
				// Alchemy defaults dev origins to `sslmode=prefer`; the docker Postgres has
				// no TLS and the dial would stall until the timeout.
				sslmode: "disable",
			},
		}
		return props
	}),
)

/**
 * Bind `MAPLE_DB` to the Worker this runs in, for the stage's flavor. Yield it
 * from the Worker's init (and from a Workflow's outer phase, which binds the
 * same name again — alchemy keys bindings by name). Plan-time only: in the
 * isolate the binding is already on the env, see {@link readMapleDbBinding}.
 * Needs `Cloudflare.Hyperdrive.ConnectBinding` on the init.
 */
export const MapleDb = (consumer: MapleDbConsumer) =>
	Effect.gen(function* () {
		if (globalThis.__ALCHEMY_RUNTIME__) return
		const stage = parseMapleStage(yield* Stage)
		switch (resolveDatabaseMode(stage)) {
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

/**
 * The `MAPLE_DB` binding off a Worker env, or `None` on a stage without a
 * database. The one place the binding's shape is checked: a value that is not
 * a Hyperdrive object reads as absent rather than throwing.
 */
export const readMapleDbBinding = (env: Record<string, unknown>): Option.Option<MapleDbBinding> =>
	Schema.decodeUnknownOption(MapleDbBinding)(env[MAPLE_DB_BINDING])
