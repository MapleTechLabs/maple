/**
 * The api app's one resource that is not the Worker's own: the replay payload
 * store, which the ingest gateway writes and the Worker (`src/worker.ts`, the
 * single-module Worker the root stack yields) reads. The root yields it first
 * for the gateway's credentials; the Worker's props yield the same declaration
 * and get that registration back.
 */
import { createHash } from "node:crypto"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Output from "alchemy/Output"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import type { MapleStage } from "@maple/infra/cloudflare"
import { resolveWorkerName } from "@maple/infra/cloudflare"
import { stageEnablesReplayBlobs } from "@maple/infra/aws"

/** R2 credentials for the ingest gateway, when this stage writes replay blobs. */
export interface ReplayBlobCredentials {
	/** Account-scoped S3 endpoint. A plan-time string — the account id is env-supplied. */
	endpoint: string
	bucket: string
	/** The API token's id. Only known after the token exists, hence an Output. */
	accessKeyId: Output.Output<string>
	/** SHA-256 of the token value; see `deriveSecretAccessKey`. */
	secretAccessKey: Output.Output<Redacted.Redacted<string>>
}

/** R2 renders an API token as S3 credentials: key id = token id, secret = SHA-256 of its value. */
const deriveSecretAccessKey = (value: Output.Output<Redacted.Redacted<string>>) =>
	Output.map(value, (token) =>
		Redacted.make(createHash("sha256").update(Redacted.value(token)).digest("hex")),
	)

/**
 * Bucket + (where the stage writes) a bucket-scoped token for the gateway.
 * Declared by id, so the two yields (root, then the Worker's props) share one
 * registration.
 */
export const createReplayBlobStore = ({ stage }: { stage: MapleStage }) =>
	Effect.gen(function* () {
		const bucketName = resolveWorkerName("replay-blobs", stage)

		// Session-replay rrweb payloads. The ingest gateway (a Rust service on ECS
		// Fargate, not a Worker) writes these over the S3 API with SigV4; the api
		// Worker binds the same bucket to hydrate `session_replay_events` rows
		// whose `Events` is empty. Stage-isolated, so a pr/stg deploy can never
		// serve or overwrite prd recordings.
		//
		// The 32-day expiry is deliberately LONGER than the table's 30-day TTL:
		// the row must disappear before the object does. The other way round
		// leaves a session that lists as recorded but plays back empty, which is
		// the one failure mode with no good client-side handling.
		// Don't add `locationHint`: it is advisory (the bucket stayed `wnam` anyway)
		// and changing it replaces a name-pinned bucket, which GC then deletes.
		// Took prd red on 2026-08-24. Colocation needs a new bucket, not a replace.
		const bucket = yield* Cloudflare.R2.Bucket("replay-blobs", {
			name: bucketName,
			// Deliberately unprefixed, so the rule covers whatever key scheme is
			// current. `replay_object_key` is versioned (`v1/…`) precisely so a
			// format change can write under a new prefix while the old one ages
			// out — a rule pinned to `v1/` would silently stop expiring anything
			// the moment that happens, and the bucket would grow forever with no
			// failing test to catch it. Nothing else writes here.
			lifecycleRules: [
				{
					id: "expire-replay-chunks",
					enabled: true,
					deleteObjectsTransition: { condition: { type: "Age", maxAge: 32 * 24 * 60 * 60 } },
				},
			],
			// Holds customer recordings. `retain` also drops a replaced generation
			// from state without the physical delete, which unwedges a half-applied
			// replace (`retainOldGeneration` in alchemy's `collectGarbage`).
		}).pipe(RemovalPolicy.retain())

		// Bucket stays bound either way, so anything already written keeps playing
		// back; without credentials the gateway just stores payloads inline.
		if (!stageEnablesReplayBlobs(stage)) return { bucket, credentials: undefined }

		// Plan-time: it keys the policy map and the endpoint, neither of which
		// can take a lazy value.
		const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
		if (!accountId) {
			throw new Error("CLOUDFLARE_ACCOUNT_ID is required to mint the replay blob store's R2 token.")
		}

		// Bucket-scoped, not account-wide. Minting it needs the DEPLOY token to
		// carry account-level `API Tokens > Write`, or the deploy fails outright.
		const token = yield* Cloudflare.ApiToken.AccountApiToken("replay-blobs-writer", {
			name: `${bucketName}-writer`,
			accountId,
			policies: [
				{
					effect: "allow",
					permissionGroups: ["Workers R2 Storage Bucket Item Write"],
					// `<account>_<jurisdiction>_<bucket>`, `default` = non-jurisdictional.
					resources: {
						[`com.cloudflare.edge.r2.bucket.${accountId}_default_${bucketName}`]: "*",
					},
				},
			],
		})

		return {
			bucket,
			credentials: {
				endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
				bucket: bucketName,
				accessKeyId: Output.asOutput(token.tokenId),
				secretAccessKey: deriveSecretAccessKey(Output.asOutput(token.value)),
			} satisfies ReplayBlobCredentials,
		}
	})
