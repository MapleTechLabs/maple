import { awsOidcIssuer } from "@maple/domain/aws"
import { Effect, Option } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import {
	type AwsOidcSigner,
	awsOidcDiscovery,
	makeAwsOidcSigner,
} from "@maple/backend/services/integrations/aws/oidc"

/**
 * Maple's OIDC issuer for AWS, `{MAPLE_API_BASE_URL}/oidc/aws`: AWS reads the discovery document
 * and the JWKS to verify the tokens Maple assumes customer roles with. Public and cacheable. The
 * issuer comes from configuration, never from request headers: customer accounts trust it as is.
 */
const PUBLIC_CACHE = { "cache-control": "public, max-age=300" }

export const AwsOidcRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const env = yield* Env
		const issuer = awsOidcIssuer(env.MAPLE_API_BASE_URL)
		// No key, or one that does not load: the issuer is absent, as AWS sees it.
		const signer = yield* Option.match(env.MAPLE_AWS_OIDC_SIGNING_KEY, {
			onNone: () => Effect.succeed(Option.none()),
			onSome: (key) =>
				makeAwsOidcSigner(issuer, key).pipe(
					Effect.tapError((error) =>
						Effect.logWarning(`AWS OIDC issuer disabled: ${error.message}`),
					),
					Effect.option,
				),
		})
		const notFound = HttpServerResponse.jsonUnsafe(
			{ error: "This Maple deployment has no AWS issuer." },
			{ status: 404 },
		)
		const serve = <A extends object>(body: (signer: AwsOidcSigner) => A) =>
			Effect.succeed(
				Option.match(signer, {
					onNone: () => notFound,
					onSome: (found) => HttpServerResponse.jsonUnsafe(body(found), { headers: PUBLIC_CACHE }),
				}),
			)
		yield* router.add(
			"GET",
			"/oidc/aws/.well-known/openid-configuration",
			serve(() => awsOidcDiscovery(issuer)),
		)
		yield* router.add(
			"GET",
			"/oidc/aws/jwks.json",
			serve((found) => ({ keys: [found.jwk] })),
		)
	}),
)
