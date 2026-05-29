import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { Effect } from "effect"
import { startServer } from "../server"

const port = Flag.integer("port").pipe(
	Flag.withDescription("Port for the HTTP endpoints"),
	Flag.withDefault(4320),
)

export const serve = Command.make("serve", { port }).pipe(
	Command.withDescription("Serve local telemetry as JSON HTTP endpoints (GET /api/*, POST /api/query)"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			yield* Effect.sync(() => startServer(a.port))
			yield* Effect.never
		}),
	),
)
