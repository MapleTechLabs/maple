import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { MAPLE_TEST_OIDC_KEY } from "./fake-aws"
import { makeAwsOidcSigner } from "./oidc"

const ISSUER = "https://api.maple.test/oidc/aws"
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"))

describe("makeAwsOidcSigner", () => {
	it.effect("signs tokens that verify with the published JWK alone", () =>
		Effect.gen(function* () {
			const signer = yield* makeAwsOidcSigner(ISSUER, Redacted.make(MAPLE_TEST_OIDC_KEY.privateKey))
			const token = yield* signer.mint("aws-connection:abc", 1_800_000_000_000)
			const [header, body, signature] = token.split(".")
			expect(decode(header ?? "")).toEqual({ alg: "RS256", typ: "JWT", kid: signer.jwk.kid })
			expect(decode(body ?? "")).toEqual({
				iss: ISSUER,
				sub: "aws-connection:abc",
				aud: "sts.amazonaws.com",
				iat: 1_800_000_000,
				nbf: 1_800_000_000,
				exp: 1_800_000_300,
			})
			// What AWS does: rebuild the key from the JWKS entry and check the signature.
			const published = yield* Effect.promise(() =>
				crypto.subtle.importKey(
					"jwk",
					signer.jwk,
					{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
					false,
					["verify"],
				),
			)
			const verify = (input: string) =>
				Effect.promise(() =>
					crypto.subtle.verify(
						"RSASSA-PKCS1-v1_5",
						published,
						Buffer.from(signature ?? "", "base64url"),
						new TextEncoder().encode(input),
					),
				)
			expect(yield* verify(`${header}.${body}`)).toBe(true)
			const forged = Buffer.from(
				JSON.stringify({ ...decode(body ?? ""), sub: "aws-connection:other" }),
			).toString("base64url")
			expect(yield* verify(`${header}.${forged}`)).toBe(false)
			// The JWK carries the public half only.
			expect(Object.keys(signer.jwk).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"])
		}),
	)

	it.effect("names the key by its RFC 7638 thumbprint, the same on every load", () =>
		Effect.gen(function* () {
			const key = Redacted.make(MAPLE_TEST_OIDC_KEY.privateKey)
			const first = yield* makeAwsOidcSigner(ISSUER, key)
			const second = yield* makeAwsOidcSigner(ISSUER, key)
			const { n, e } = first.jwk
			const digest = yield* Effect.promise(() =>
				crypto.subtle.digest(
					"SHA-256",
					new TextEncoder().encode(`{"e":"${e}","kty":"RSA","n":"${n}"}`),
				),
			)
			expect(first.jwk.kid).toBe(Buffer.from(digest).toString("base64url"))
			expect(second.jwk.kid).toBe(first.jwk.kid)
		}),
	)

	it.effect("fails typed on a key that is not PKCS#8 RSA", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(makeAwsOidcSigner(ISSUER, Redacted.make("not a key")))
			expect(error._tag).toBe("@maple/backend/integrations/AwsOidcKeyError")
		}),
	)
})
