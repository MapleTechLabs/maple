/**
 * The key Maple signs its AWS OIDC tokens with. Customer roles trust the issuer
 * `{MAPLE_API_BASE_URL}/oidc/aws`, and AWS verifies tokens against the JWKS api serves from this
 * key. It lives in alchemy state, one per stage. Renaming the resource rotates it: tokens signed
 * with the old key stop verifying once AWS refetches the JWKS.
 */
import * as Alchemy from "alchemy"
import type * as Output from "alchemy/Output"
import * as Effect from "effect/Effect"
import type * as Redacted from "effect/Redacted"

/** The env api and alerting read the key from (`packages/backend/src/platform/Env.ts`). */
export interface MapleAwsOidcEnv {
	readonly MAPLE_AWS_OIDC_SIGNING_KEY: Output.Output<Redacted.Redacted<string>>
}

export const createMapleAwsOidcKey = () =>
	Effect.gen(function* () {
		const key = yield* Alchemy.KeyPair("aws-oidc-signing-key", { algorithm: "rsa", modulusLength: 2048 })
		const env: MapleAwsOidcEnv = { MAPLE_AWS_OIDC_SIGNING_KEY: key.privateKey }
		return env
	})
