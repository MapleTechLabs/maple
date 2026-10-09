/**
 * The sandbox Worker's declaration, kept out of `src/worker.ts` so that module stays
 * a plain bundle entry and its `Sandbox` class export survives into the script.
 */
import {
	assetWorkerObservability,
	MapleStack,
	mapleWorkerProps,
	resolveStorageJurisdiction,
	resolveWorkerName,
	WorkersObservabilityDestinations,
} from "@maple/infra/cloudflare"
import { requireSecretEntry } from "@maple/infra/env"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"
import type { Sandbox } from "./src/worker.ts"

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
	const jurisdiction = resolveStorageJurisdiction(region)
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
	const production = stack.stage.kind === "prd"
	// No OTel SDK in this Worker, so platform logs are its only telemetry. Keep them on.
	const destinations = yield* WorkersObservabilityDestinations
	return {
		main: `${import.meta.dirname}/src/worker.ts`,
		...mapleWorkerProps("sandbox", stack),
		// Reached only over a service binding: no route, no hostname.
		workersDev: false,
		observability: assetWorkerObservability(destinations),
		env: {
			Sandbox: Cloudflare.Container<Sandbox>("Sandbox", {
				context: SANDBOX_IMAGE_CONTEXT,
				// Full clones exhaust the smaller tiers' disk. Named tiers are the only dial:
				// Cloudflare rejects explicit vcpu/memory/disk alongside one.
				instanceType: production ? ("standard-2" as const) : ("standard-1" as const),
				// One container per repository per org: the cap on concurrent repositories.
				maxInstances: production ? 40 : 5,
				observability: { logs: { enabled: true } },
			}),
			// Never the shared `INTERNAL_SERVICE_TOKEN` (acts as any org; this runs model-chosen
			// commands). Required so a missing token fails the deploy, not every call.
			...(yield* requireSecretEntry("SANDBOX_INTERNAL_SERVICE_TOKEN")),
			...(yield* mirrorBackups),
		},
	}
})

export default class MapleSandbox extends Cloudflare.Worker<MapleSandbox>()("sandbox", props) {}
