/**
 * The sandbox Worker's declaration, kept beside the app like ingest's and
 * electric's rather than inside `src/worker.ts`: that module has to stay a plain
 * bundle entry so its `Sandbox` class export survives into the deployed script,
 * which it would not if alchemy generated the entry around it.
 *
 * The container is bound in `env`, which is alchemy's form for a container-backed
 * class an image provides: it emits the Durable Object namespace, marks the class
 * container-backed in the script metadata, and provisions the application.
 */
import { CLOUDFLARE_WORKER_PLACEMENT, MapleStack, resolveWorkerName } from "@maple/infra/cloudflare"
import { optionalSecret } from "@maple/infra/env"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"
import type { Sandbox } from "./src/worker.ts"

/**
 * Cloudflare's published sandbox image, pinned. Alchemy pulls it and re-pushes it
 * to the account registry, so a bump is a real deploy step and not a silent
 * upstream change under a running fleet.
 */
const SANDBOX_IMAGE = "docker.io/cloudflare/sandbox:0.12.9"

const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: `${import.meta.dirname}/src/worker.ts` }
	const { stage } = yield* MapleStack
	const production = stage.kind === "prd"
	return {
		main: `${import.meta.dirname}/src/worker.ts`,
		name: resolveWorkerName("sandbox", stage),
		compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
		placement: CLOUDFLARE_WORKER_PLACEMENT,
		// Reached only over the api's service binding: no route, no hostname.
		workersDev: false,
		env: {
			Sandbox: Cloudflare.Container<Sandbox>("Sandbox", {
				image: SANDBOX_IMAGE,
				instanceType: production ? ("standard-1" as const) : ("dev" as const),
				maxInstances: production ? 20 : stage.kind === "stg" ? 5 : 2,
				observability: { logs: { enabled: true } },
			}),
			...(yield* optionalSecret("INTERNAL_SERVICE_TOKEN")),
		},
	}
})

export default class MapleSandbox extends Cloudflare.Worker<MapleSandbox>()("sandbox", props) {}
