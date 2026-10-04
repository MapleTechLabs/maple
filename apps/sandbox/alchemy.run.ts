/**
 * The sandbox Worker's declaration, kept out of `src/worker.ts` so that module stays
 * a plain bundle entry and its `Sandbox` class export survives into the script.
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

/** Pinned; alchemy re-pushes it to the account registry, so a bump is a deploy step. */
const SANDBOX_IMAGE = "docker.io/cloudflare/sandbox:0.12.10"

/**
 * Git mirror archives between container lifetimes, plus the SDK's S3 credentials.
 * Customer source: follows the storage jurisdiction; expires a day after the SDK's
 * 7-day TTL, since the SDK never deletes archives.
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
				// A container sleeping mid-upload leaves parts object expiry never sees.
				abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 24 * 60 * 60 } },
			},
		],
		// A cache: every archive can be rebuilt by one clone, so a teardown may empty it.
		forceDestroy: true,
	})
	// Bucket-scoped; minting needs account-level `API Tokens > Write` on the deploy token.
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
	// No OTel SDK in this Worker, so platform logs are its only telemetry. Keep them on.
	const destinations = yield* WorkersObservabilityDestinations
	return {
		main: `${import.meta.dirname}/src/worker.ts`,
		name: resolveWorkerName("sandbox", stage, region),
		compatibility: { date: "2026-10-01" },
		placement: resolveWorkerPlacement(region),
		// Reached only over a service binding: no route, no hostname.
		workersDev: false,
		observability: assetWorkerObservability(destinations),
		env: {
			Sandbox: Cloudflare.Container<Sandbox>("Sandbox", {
				image: SANDBOX_IMAGE,
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
