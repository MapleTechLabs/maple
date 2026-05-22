import { createPrivateKey, createSign } from "node:crypto"
import {
	GithubUpstreamError,
	GithubValidationError,
} from "@maple/domain/http"
import { Context, Effect, Layer, Option, Redacted } from "effect"
import { Env, type EnvShape } from "./Env"

const JWT_TTL_SECONDS = 540 // 9 minutes — under GitHub's 10-minute max
const INSTALLATION_TOKEN_REFRESH_LEEWAY_MS = 5 * 60_000 // 5 minutes

const base64UrlEncode = (input: Buffer | string): string => {
	const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const normalizePem = (raw: string): string => {
	// CF dashboard sometimes collapses newlines into literal "\n" or strips them. Re-expand.
	const expanded = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw
	return expanded.trim()
}

interface ResolvedGithubAppConfig {
	readonly appId: string
	readonly appSlug: string
	readonly privateKeyPem: string
	readonly webhookSecret: string
	readonly apiBaseUrl: string
	readonly appBaseUrl: string
}

const requireSome = <A>(
	opt: Option.Option<A>,
	message: string,
): Effect.Effect<A, GithubValidationError> =>
	Option.match(opt, {
		onNone: () => Effect.fail(new GithubValidationError({ message })),
		onSome: (value) => Effect.succeed(value),
	})

export const resolveGithubAppConfig = (
	env: EnvShape,
): Effect.Effect<ResolvedGithubAppConfig, GithubValidationError> =>
	Effect.gen(function* () {
		const appId = yield* requireSome(
			env.GITHUB_APP_ID,
			"GITHUB_APP_ID is required to use the GitHub integration",
		)
		const appSlug = yield* requireSome(
			env.GITHUB_APP_SLUG,
			"GITHUB_APP_SLUG is required to use the GitHub integration",
		)
		const privateKey = yield* requireSome(
			env.GITHUB_APP_PRIVATE_KEY,
			"GITHUB_APP_PRIVATE_KEY is required to use the GitHub integration",
		)
		const webhookSecret = yield* requireSome(
			env.GITHUB_APP_WEBHOOK_SECRET,
			"GITHUB_APP_WEBHOOK_SECRET is required to use the GitHub integration",
		)
		return {
			appId,
			appSlug,
			privateKeyPem: normalizePem(Redacted.value(privateKey)),
			webhookSecret: Redacted.value(webhookSecret),
			apiBaseUrl: env.GITHUB_API_BASE_URL.replace(/\/$/, ""),
			appBaseUrl: env.GITHUB_APP_BASE_URL.replace(/\/$/, ""),
		}
	})

export const githubIntegrationMissingEnv = (env: EnvShape): ReadonlyArray<string> => {
	const missing: string[] = []
	if (Option.isNone(env.GITHUB_APP_ID)) missing.push("GITHUB_APP_ID")
	if (Option.isNone(env.GITHUB_APP_SLUG)) missing.push("GITHUB_APP_SLUG")
	if (Option.isNone(env.GITHUB_APP_PRIVATE_KEY)) missing.push("GITHUB_APP_PRIVATE_KEY")
	if (Option.isNone(env.GITHUB_APP_WEBHOOK_SECRET)) missing.push("GITHUB_APP_WEBHOOK_SECRET")
	return missing
}

export interface GithubInstallationToken {
	readonly token: string
	readonly expiresAt: number
}

export interface GithubAppJwtServiceShape {
	readonly resolveConfig: Effect.Effect<ResolvedGithubAppConfig, GithubValidationError>
	readonly mintAppJwt: Effect.Effect<string, GithubValidationError | GithubUpstreamError>
	readonly getInstallationToken: (
		installationId: number,
	) => Effect.Effect<
		GithubInstallationToken,
		GithubValidationError | GithubUpstreamError
	>
	readonly invalidateInstallationToken: (installationId: number) => Effect.Effect<void>
	readonly verifyWebhookSignature: (
		signatureHeader: string | null | undefined,
		body: ArrayBuffer,
	) => Effect.Effect<boolean, GithubValidationError>
}

const toUpstreamError = (message: string, status?: number) =>
	new GithubUpstreamError({ message, ...(status === undefined ? {} : { status }) })

export class GithubAppJwtService extends Context.Service<
	GithubAppJwtService,
	GithubAppJwtServiceShape
>()("GithubAppJwtService", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const cache = new Map<number, GithubInstallationToken>()

		const resolveConfig = resolveGithubAppConfig(env)

		const mintAppJwt = Effect.fn("GithubAppJwtService.mintAppJwt")(function* () {
			const config = yield* resolveConfig
			const now = Math.floor(Date.now() / 1000)
			const header = { alg: "RS256", typ: "JWT" }
			const payload = {
				iat: now - 60,
				exp: now + JWT_TTL_SECONDS,
				iss: config.appId,
			}
			const headerEncoded = base64UrlEncode(JSON.stringify(header))
			const payloadEncoded = base64UrlEncode(JSON.stringify(payload))
			const signingInput = `${headerEncoded}.${payloadEncoded}`

			const signature = yield* Effect.try({
				try: () => {
					const key = createPrivateKey({ key: config.privateKeyPem, format: "pem" })
					const signer = createSign("RSA-SHA256")
					signer.update(signingInput)
					signer.end()
					return signer.sign(key)
				},
				catch: (cause) =>
					toUpstreamError(
						cause instanceof Error
							? `Failed to sign GitHub App JWT: ${cause.message}`
							: "Failed to sign GitHub App JWT",
					),
			})

			return `${signingInput}.${base64UrlEncode(signature)}`
		})

		const requestInstallationToken = Effect.fn(
			"GithubAppJwtService.requestInstallationToken",
		)(function* (installationId: number) {
			const config = yield* resolveConfig
			const jwt = yield* mintAppJwt()
			const response = yield* Effect.tryPromise({
				try: () =>
					fetch(`${config.apiBaseUrl}/app/installations/${installationId}/access_tokens`, {
						method: "POST",
						headers: {
							authorization: `Bearer ${jwt}`,
							accept: "application/vnd.github+json",
							"x-github-api-version": "2022-11-28",
							"user-agent": "maple-github-app",
						},
					}),
				catch: (cause) =>
					toUpstreamError(
						cause instanceof Error
							? `Installation token request failed: ${cause.message}`
							: "Installation token request failed",
					),
			})
			if (!response.ok) {
				const text = yield* Effect.tryPromise({
					try: () => response.text(),
					catch: () => toUpstreamError("Installation token request failed", response.status),
				})
				return yield* Effect.fail(
					toUpstreamError(
						`Installation token request failed (${response.status}): ${text || response.statusText}`,
						response.status,
					),
				)
			}
			const json = (yield* Effect.tryPromise({
				try: () => response.json() as Promise<{ token: string; expires_at: string }>,
				catch: () => toUpstreamError("Installation token response was not JSON"),
			})) as { token: string; expires_at: string }
			const expiresAt = Date.parse(json.expires_at)
			if (!Number.isFinite(expiresAt)) {
				return yield* Effect.fail(toUpstreamError("Installation token has invalid expiry"))
			}
			return { token: json.token, expiresAt } satisfies GithubInstallationToken
		})

		const getInstallationToken = Effect.fn("GithubAppJwtService.getInstallationToken")(function* (
			installationId: number,
		) {
			const cached = cache.get(installationId)
			if (cached && cached.expiresAt - Date.now() > INSTALLATION_TOKEN_REFRESH_LEEWAY_MS) {
				return cached
			}
			const fresh = yield* requestInstallationToken(installationId)
			cache.set(installationId, fresh)
			return fresh
		})

		const invalidateInstallationToken = (installationId: number) =>
			Effect.sync(() => {
				cache.delete(installationId)
			})

		const verifyWebhookSignature = Effect.fn("GithubAppJwtService.verifyWebhookSignature")(
			function* (signatureHeader: string | null | undefined, body: ArrayBuffer) {
				if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
					return false
				}
				const config = yield* resolveConfig
				const provided = signatureHeader.slice("sha256=".length)
				const providedBytes = yield* Effect.try({
					try: () => {
						if (!/^[0-9a-f]+$/i.test(provided) || provided.length % 2 !== 0) {
							throw new Error("malformed signature")
						}
						const out = new Uint8Array(provided.length / 2)
						for (let i = 0; i < out.length; i++) {
							out[i] = Number.parseInt(provided.slice(i * 2, i * 2 + 2), 16)
						}
						return out
					},
					catch: () =>
						new GithubValidationError({ message: "Malformed GitHub webhook signature" }),
				})

				const key = yield* Effect.tryPromise({
					try: () =>
						crypto.subtle.importKey(
							"raw",
							new TextEncoder().encode(config.webhookSecret),
							{ name: "HMAC", hash: "SHA-256" },
							false,
							["verify", "sign"],
						),
					catch: () =>
						new GithubValidationError({
							message: "Failed to import webhook secret",
						}),
				})

				return yield* Effect.tryPromise({
					try: () => crypto.subtle.verify("HMAC", key, providedBytes, body),
					catch: () =>
						new GithubValidationError({
							message: "Failed to verify webhook signature",
						}),
				})
			},
		)

		return {
			resolveConfig,
			mintAppJwt: mintAppJwt(),
			getInstallationToken,
			invalidateInstallationToken,
			verifyWebhookSignature,
		} satisfies GithubAppJwtServiceShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
	static readonly Default = this.layer
}
