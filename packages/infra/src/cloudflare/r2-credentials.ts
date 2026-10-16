import { createHash } from "node:crypto"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Output from "alchemy/Output"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"

type R2Permission = "Workers R2 Storage Bucket Item Read" | "Workers R2 Storage Bucket Item Write"

/**
 * S3-compatible credentials for one R2 bucket: a bucket-scoped API token, which R2 renders as
 * key id = token id and secret = SHA-256 of the token value. Minting it needs the deploy token
 * to carry account-level `API Tokens > Write`. `id` is the token's logical id.
 */
export const r2BucketCredentials = Effect.fn(function* ({
	id,
	tokenName,
	bucketName,
	jurisdiction,
	permissions,
}: {
	id: string
	tokenName: string
	bucketName: string
	jurisdiction: "eu" | undefined
	permissions: ReadonlyArray<R2Permission>
}) {
	// Plan-time: it keys the token's resource and the endpoint.
	const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment
	const token = yield* Cloudflare.ApiToken.AccountApiToken(id, {
		name: tokenName,
		accountId,
		policies: [
			{
				effect: "allow",
				permissionGroups: [...permissions],
				// `<account>_<jurisdiction>_<bucket>`; `default` is the non-jurisdictional bucket.
				resources: {
					[`com.cloudflare.edge.r2.bucket.${accountId}_${jurisdiction ?? "default"}_${bucketName}`]:
						"*",
				},
			},
		],
	})
	return {
		accountId,
		// A jurisdictional bucket answers only on its own S3 endpoint.
		endpoint:
			jurisdiction === undefined
				? `https://${accountId}.r2.cloudflarestorage.com`
				: `https://${accountId}.${jurisdiction}.r2.cloudflarestorage.com`,
		accessKeyId: Output.map(Output.asOutput(token.tokenId), (tokenId) => Redacted.make(tokenId)),
		secretAccessKey: Output.map(Output.asOutput(token.value), (value) =>
			Redacted.make(createHash("sha256").update(Redacted.value(value)).digest("hex")),
		),
	}
})
