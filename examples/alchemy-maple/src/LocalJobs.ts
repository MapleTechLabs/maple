import * as Cloudflare from "@alchemy.run/cloudflare"
import { Telemetry } from "@maple-dev/alchemy/telemetry"
import { Effect } from "effect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { Observability } from "./Observability.ts"

export default Cloudflare.Worker(
	"local-jobs",
	{ main: import.meta.url },
	Effect.succeed({
		fetch: Effect.gen(function* () {
			yield* Effect.log("handling local jobs request")
			return HttpServerResponse.text("jobs")
		}),
		// Worker init is the composition root: Telemetry registers the per-request layer here.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
	}).pipe(Effect.provide(Telemetry({ serviceName: "local-jobs", local: Observability }))),
)
