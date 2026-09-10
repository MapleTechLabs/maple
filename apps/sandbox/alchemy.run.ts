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
import { requireSecretEntry } from "@maple/infra/env"
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
				// Sized for the work, not for the stage. The checkout is a full clone,
				// so the smaller tiers are not a cheaper version of this container —
				// `lite`/`dev` is 1/16 vCPU with 256 MiB and 2 GB of disk, which any
				// real repository exhausts. Staging runs the same shape as production
				// because a sandbox that only fails there tells us nothing.
				// The tier carries its own disk (`standard-2` 1 vCPU/6 GiB/12 GB,
				// `standard-1` 1/2 vCPU/4 GiB/8 GB) and Cloudflare rejects a request that
				// also sets vcpu/memory/disk, so the named tier is the only dial we have.
				instanceType: production ? ("standard-2" as const) : ("standard-1" as const),
				// The cap is per application, and the key is one container per
				// repository per organization, so this is how many distinct repositories
				// can be under investigation at once before calls start being refused.
				maxInstances: production ? 40 : 5,
				observability: { logs: { enabled: true } },
			}),
			// Deliberately not the shared `INTERNAL_SERVICE_TOKEN`: that one lets its
			// holder act as any organization, and this Worker runs model-chosen commands.
			// Required, not optional: this Worker is only created on the stages that
			// deploy it, and without the token it answers 401 to every api call, which
			// is a failure worth having at deploy time rather than at the first tool use.
			...(yield* requireSecretEntry("SANDBOX_INTERNAL_SERVICE_TOKEN")),
		},
	}
})

export default class MapleSandbox extends Cloudflare.Worker<MapleSandbox>()("sandbox", props) {}
