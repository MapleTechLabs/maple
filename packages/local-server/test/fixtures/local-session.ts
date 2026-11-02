// One `alchemy dev` sidecar's worth of Maple Local, as its own process: starts
// (or shares) the store at argv[2] on port argv[3], prints the result on a
// `SESSION ` line, and closes its scope on SIGTERM like a clean Ctrl-C.
import { Effect, Exit, Scope } from "effect"
import { startLocal } from "../../src/runtime"

const [dataDir = "", port = "0"] = process.argv.slice(2)
const scope = Effect.runSync(Scope.make())
const started = await Effect.runPromiseExit(
	startLocal({ dataDir, port: Number(port) }).pipe(Scope.provide(scope)),
)
if (Exit.isFailure(started)) {
	process.stdout.write(`SESSION ${JSON.stringify({ error: String(started.cause) })}\n`)
	process.exit(1)
}
process.stdout.write(`SESSION ${JSON.stringify(started.value)}\n`)

const stop = () => {
	void Effect.runPromise(Scope.close(scope, Exit.void)).then(() => process.exit(0))
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
setInterval(() => undefined, 1 << 30)
