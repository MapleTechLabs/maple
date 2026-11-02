// `<sidecar>/maple-server.json`: how other processes find the server that owns a
// store. `maple start` and the embedded runtime both write it once listening.
import { Effect, Option, Schema } from "effect"
import { readFileSync, unlinkSync } from "node:fs"
import { durableWrite } from "./durable-files"
import { ignoreFailure, isProcessAlive } from "./store-claim"
import { stateFileError } from "./store-errors"

export const ServerDiscovery = Schema.Struct({
	pid: Schema.Int,
	url: Schema.String,
	dataDir: Schema.String,
	startedAt: Schema.String,
})
export type ServerDiscovery = typeof ServerDiscovery.Type

const decodeDiscovery = Schema.decodeUnknownOption(Schema.fromJsonString(ServerDiscovery))

export const readDiscovery = (path: string): Effect.Effect<Option.Option<ServerDiscovery>> =>
	Effect.try({
		try: () => readFileSync(path, "utf8"),
		catch: (error) => error,
	}).pipe(
		Effect.map(decodeDiscovery),
		Effect.orElseSucceed(() => Option.none<ServerDiscovery>()),
	)

export const writeDiscovery = (path: string, discovery: ServerDiscovery) =>
	Effect.tryPromise({
		try: () => durableWrite(path, `${JSON.stringify(discovery, null, 2)}\n`),
		catch: stateFileError(path, "write"),
	})

/** Delete the discovery file when (and only when) it names `pid`. */
export const removeDiscoveryFor = (path: string, pid: number): Effect.Effect<void> =>
	Effect.gen(function* () {
		const current = yield* readDiscovery(path)
		if (Option.isSome(current) && current.value.pid === pid) {
			yield* ignoreFailure(() => unlinkSync(path))
		}
	})

/** Delete a discovery file whose server is gone (crash, `kill -9`). */
export const removeStaleDiscovery = (path: string): Effect.Effect<void> =>
	Effect.gen(function* () {
		const current = yield* readDiscovery(path)
		if (
			Option.isSome(current) &&
			current.value.pid !== process.pid &&
			!isProcessAlive(current.value.pid)
		) {
			yield* ignoreFailure(() => unlinkSync(path))
		}
	})
