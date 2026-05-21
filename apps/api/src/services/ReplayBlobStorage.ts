import { AwsClient } from "aws4fetch"
import { Context, Effect, Layer, Option, Redacted } from "effect"
import { Env } from "./Env"

// ---------------------------------------------------------------------------
// ReplayBlobStorage
//
// Session-replay rrweb event blobs live in Cloudflare R2, keyed by
// `{orgId}/{sessionId}/{chunkSeq}.json.gz` (chunkSeq zero-padded to 8 digits —
// MUST match the key the ingest gateway writes in apps/ingest). This service
// mints short-lived presigned GET URLs so the browser player streams blobs
// straight from R2; the bytes never transit the API.
//
// Presigning uses aws4fetch (Cloudflare's recommended SigV4 signer for R2 on
// Workers) against R2's S3-compatible endpoint.
// ---------------------------------------------------------------------------

const URL_TTL_SECONDS = 300

export class ReplayBlobStorageError extends Error {
	readonly _tag = "ReplayBlobStorageError"
}

export interface ReplayBlobStorageShape {
	/** Object key for a session's chunk. Stable contract shared with the ingest gateway. */
	readonly chunkKey: (orgId: string, sessionId: string, chunkSeq: number) => string
	/** Presigned GET URL (valid ~5 min) for a chunk blob. */
	readonly presignChunkUrl: (
		orgId: string,
		sessionId: string,
		chunkSeq: number,
	) => Effect.Effect<string, ReplayBlobStorageError>
}

const chunkKey = (orgId: string, sessionId: string, chunkSeq: number): string =>
	`${orgId}/${sessionId}/${String(chunkSeq).padStart(8, "0")}.json.gz`

const make = Effect.gen(function* () {
	const env = yield* Env

	const configured =
		Option.isSome(env.R2_ENDPOINT) &&
		Option.isSome(env.R2_ACCESS_KEY_ID) &&
		Option.isSome(env.R2_SECRET_ACCESS_KEY)

	const signer = configured
		? new AwsClient({
				accessKeyId: env.R2_ACCESS_KEY_ID.pipe(Option.getOrThrow),
				secretAccessKey: Redacted.value(env.R2_SECRET_ACCESS_KEY.pipe(Option.getOrThrow)),
				service: "s3",
				region: "auto",
			})
		: null

	const endpoint = Option.getOrElse(env.R2_ENDPOINT, () => "")

	const presignChunkUrl = (
		orgId: string,
		sessionId: string,
		chunkSeq: number,
	): Effect.Effect<string, ReplayBlobStorageError> => {
		if (!signer) {
			return Effect.fail(
				new ReplayBlobStorageError(
					"R2 is not configured (set R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)",
				),
			)
		}
		const key = chunkKey(orgId, sessionId, chunkSeq)
		const url = `${endpoint.replace(/\/$/, "")}/${env.R2_BUCKET}/${key}?X-Amz-Expires=${URL_TTL_SECONDS}`
		return Effect.tryPromise({
			try: async () => {
				const signed = await signer.sign(url, { method: "GET", aws: { signQuery: true } })
				return signed.url
			},
			catch: (cause) =>
				new ReplayBlobStorageError(
					`failed to presign replay chunk URL: ${cause instanceof Error ? cause.message : String(cause)}`,
				),
		})
	}

	return { chunkKey, presignChunkUrl } satisfies ReplayBlobStorageShape
})

export class ReplayBlobStorage extends Context.Service<ReplayBlobStorage, ReplayBlobStorageShape>()(
	"@maple/api/services/ReplayBlobStorage",
) {
	static readonly layer = Layer.effect(this, make)
}
