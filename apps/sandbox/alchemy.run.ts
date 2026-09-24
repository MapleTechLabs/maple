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
import { createHash } from "node:crypto"
import {
	MapleStack,
	WorkersObservabilityDestinations,
	assetWorkerObservability,
	resolveStorageJurisdiction,
	resolveWorkerName,
	resolveWorkerPlacement,
} from "@maple/infra/cloudflare"
import { requireSecretEntry } from "@maple/infra/env"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Output from "alchemy/Output"
import { Effect, Redacted } from "effect"
import type { Sandbox } from "./src/worker.ts"

/**
 * Cloudflare's published sandbox image, pinned. Alchemy pulls it and re-pushes it
 * to the account registry, so a bump is a real deploy step and not a silent
 * upstream change under a running fleet.
 */
const SANDBOX_IMAGE = "docker.io/cloudflare/sandbox:0.12.10"

/**
 * Where each repository's git mirror is archived between container lifetimes
 * (`src/mirror-backup.ts`), with the S3 credentials the Sandbox SDK signs its
 * transfers with. Customer source, so it follows the instance's storage
 * jurisdiction and expires a day after the SDK's own 7-day TTL: the SDK marks an
 * archive expired but never deletes it.
 */
const mirrorBackups = Effect.gen(function* () {
	const { stage, region } = yield* MapleStack
	const bucketName = resolveWorkerName("sandbox-mirrors", stage, region)
	const jurisdiction = resolveStorageJurisdiction(region)
	// Plan-time: it keys the token's resource and the endpoint.
	const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment
	const bucket = yield* Cloudflare.R2.Bucket("sandbox-mirrors", {
		name: bucketName,
		jurisdiction,
		lifecycleRules: [
			{
				id: "expire-mirror-backups",
				enabled: true,
				deleteObjectsTransition: { condition: { type: "Age", maxAge: 8 * 24 * 60 * 60 } },
			},
		],
	})
	// Bucket-scoped, like ingest's replay writer. Minting it needs the deploy token to
	// carry account-level `API Tokens > Write`.
	const token = yield* Cloudflare.ApiToken.AccountApiToken("sandbox-mirrors-rw", {
		name: `${bucketName}-rw`,
		accountId,
		policies: [
			{
				effect: "allow",
				permissionGroups: [
					"Workers R2 Storage Bucket Item Read",
					"Workers R2 Storage Bucket Item Write",
				],
				resources: {
					[`com.cloudflare.edge.r2.bucket.${accountId}_${jurisdiction ?? "default"}_${bucketName}`]:
						"*",
				},
			},
		],
	})
	return {
		BACKUP_BUCKET: bucket,
		BACKUP_BUCKET_NAME: bucketName,
		CLOUDFLARE_ACCOUNT_ID: accountId,
		// A jurisdictional bucket answers only on its own S3 endpoint; the SDK derives the default one.
		BACKUP_BUCKET_ENDPOINT:
			jurisdiction === undefined
				? `https://${accountId}.r2.cloudflarestorage.com`
				: `https://${accountId}.${jurisdiction}.r2.cloudflarestorage.com`,
		// R2 renders an API token as S3 credentials: key id = token id, secret = SHA-256 of its value.
		R2_ACCESS_KEY_ID: Output.map(Output.asOutput(token.tokenId), (id) => Redacted.make(id)),
		R2_SECRET_ACCESS_KEY: Output.map(Output.asOutput(token.value), (value) =>
			Redacted.make(createHash("sha256").update(Redacted.value(value)).digest("hex")),
		),
	}
})

const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: `${import.meta.dirname}/src/worker.ts` }
	const { stage, region } = yield* MapleStack
	const production = stage.kind === "prd"
	// This Worker carries no OTel SDK — it is a plain module so its `Sandbox`
	// class export survives — so platform logs are the only way anything it
	// records leaves the account. Without them a bug here is a 500 with nothing
	// behind it, which is exactly how one shipped.
	const destinations = yield* WorkersObservabilityDestinations
	return {
		main: `${import.meta.dirname}/src/worker.ts`,
		name: resolveWorkerName("sandbox", stage, region),
		compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
		// The container has no jurisdiction setting of its own, so the clone sits
		// under the same best-effort placement as the Workers.
		placement: resolveWorkerPlacement(region),
		// Reached only over the api's service binding: no route, no hostname.
		workersDev: false,
		observability: assetWorkerObservability(destinations),
		env: {
			Sandbox: Cloudflare.Container<Sandbox>("Sandbox", {
				image: SANDBOX_IMAGE,
				// Sized for the work, not for the stage. The checkout is a full clone,
				// so the smaller tiers are not a cheaper version of this container —
				// `lite`/`dev` is 1/16 vCPU with 256 MiB and 2 GB of disk, which any
				// real repository exhausts.
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
			...(yield* mirrorBackups),
		},
	}
})

export default class MapleSandbox extends Cloudflare.Worker<MapleSandbox>()("sandbox", props) {}
