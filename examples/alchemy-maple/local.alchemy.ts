import * as Alchemy from "alchemy"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { localProviders } from "@maple-dev/alchemy/local"
import { Effect, Layer } from "effect"
import Api from "./src/LocalApi.ts"
import Jobs from "./src/LocalJobs.ts"
import { Observability } from "./src/Observability.ts"

export default Alchemy.Stack(
	"maple-local-example",
	{
		state: Alchemy.localState(),
		providers: Layer.mergeAll(Cloudflare.providers(), localProviders()),
	},
	Effect.gen(function* () {
		const local = yield* Observability
		const api = yield* Api
		const jobs = yield* Jobs
		return { api: api.url, jobs: jobs.url, endpoint: local.endpoint, dashboard: local.dashboardUrl }
	}),
)
