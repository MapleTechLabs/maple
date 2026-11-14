/**
 * The sandbox Worker's declaration, kept out of `src/worker.ts` so that module stays
 * a plain bundle entry and its `Sandbox` class export survives into the script.
 */
import {
	assetWorkerObservability,
	MapleStack,
	mapleWorkerProps,
	REGION_INFRA,
	resolveWorkerName,
	WorkersObservabilityDestinations,
} from "@maple/infra/cloudflare"
import { resolveWorkerEnv } from "@maple/infra/secret-guard"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Effect } from "effect"
import { sandboxSecrets } from "./alchemy/secrets.ts"
import type { Executor, Sandbox } from "./src/worker.ts"

/**
 * The container image, built here and pushed to the account registry on a content change. Its
 * `sandbox-shim` tag must match the `@cloudflare/sandbox` version in `package.json`.
 */
const SANDBOX_IMAGE_CONTEXT = `${import.meta.dirname}/image`

/**
 * Git mirror archives between container lifetimes. Customer source: follows the storage
 * jurisdiction, and the lifecycle rule is the only thing that deletes an archive, so it bounds how
 * long a disconnected repository's source stays in R2. Daily refreshes keep an active one fresh.
 * The container never holds credentials for it: `DirectoryBackupGateway` moves each archive
 * through the Worker.
 */
const mirrorBackups = Effect.gen(function* () {
	const { stage, region } = yield* MapleStack
	const bucketName = resolveWorkerName("sandbox-mirrors", stage, region)
	const jurisdiction = REGION_INFRA[region].storageJurisdiction
	const bucket = yield* Cloudflare.R2.Bucket("sandbox-mirrors", {
		name: bucketName,
		jurisdiction,
		lifecycleRules: [
			{
				id: "expire-mirror-backups",
				enabled: true,
				deleteObjectsTransition: { condition: { type: "Age", maxAge: 8 * 24 * 60 * 60 } },
				// A container sleeping mid-upload leaves parts object expiry never sees.
				abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 24 * 60 * 60 } },
			},
		],
		// A cache: every archive can be rebuilt by one clone, so a teardown may empty it.
		forceDestroy: true,
	})
	return { BACKUP_BUCKET: bucket }
})

const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: `${import.meta.dirname}/src/worker.ts` }
	const stack = yield* MapleStack
	const { instanceType, maxInstances, executorMaxInstances } = stack.profile.sandbox
	// No OTel SDK in this Worker, so platform logs are its only telemetry. Keep them on.
	const destinations = yield* WorkersObservabilityDestinations
	return {
		main: `${import.meta.dirname}/src/worker.ts`,
		...mapleWorkerProps("sandbox", stack),
		// Reached only over a service binding: no route, no hostname.
		workersDev: false,
		// Hourly, and a no-op once the current probe version has reported.
		crons: ["23 * * * *"],
		observability: assetWorkerObservability(destinations),
		env: {
			// Fleet scheduling on purpose: `durable_object` has no `maxInstances` cap, and
			// switching policy needs a new application and Durable Object namespace.
			Sandbox: Cloudflare.Container<Sandbox>("Sandbox", {
				context: SANDBOX_IMAGE_CONTEXT,
				instanceType,
				maxInstances,
				observability: { logs: { enabled: true } },
			}),
			// The execution sandbox: started with internet off, one per security audit run (and the
			// platform probe on the cron below). Probe v2: standard-2 is 1 vCPU, 6 GB, 11 GB disk.
			Executor: Cloudflare.Container<Executor>("Executor", {
				context: SANDBOX_IMAGE_CONTEXT,
				instanceType: "standard-2" as const,
				maxInstances: executorMaxInstances,
				observability: { logs: { enabled: true } },
			}),
			...(yield* resolveWorkerEnv("sandbox", sandboxSecrets)),
			...(yield* mirrorBackups),
		},
	}
})

export default class MapleSandbox extends Cloudflare.Worker<MapleSandbox>()("sandbox", props) {}
