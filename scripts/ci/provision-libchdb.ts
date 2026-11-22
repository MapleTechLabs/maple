// The pinned libchdb for this runner, downloaded and checksum-verified, exported to later steps
// as MAPLE_LIBCHDB. For a job that needs the engine and not the whole native bundle.
import { appendFileSync } from "node:fs"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { provisionLibchdb } from "../../packages/local-server/src/libchdb-provision"

const { path } = await Effect.runPromise(provisionLibchdb().pipe(Effect.provide(FetchHttpClient.layer)))
if (process.env.GITHUB_ENV === undefined) process.stdout.write(`${path}\n`)
else appendFileSync(process.env.GITHUB_ENV, `MAPLE_LIBCHDB=${path}\n`)
