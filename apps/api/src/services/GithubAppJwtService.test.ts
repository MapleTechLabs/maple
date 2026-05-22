import { createPublicKey, createVerify, createHmac } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { GithubAppJwtService } from "./GithubAppJwtService"
import {
	cleanupTempDirs,
	createTempDbUrl as makeTempDb,
} from "./test-sqlite"
import {
	fullGithubConfig,
	makeBaseLayer,
	testRsaKey,
} from "./github-test-helpers"

const createdTempDirs: string[] = []
afterEach(() => cleanupTempDirs(createdTempDirs))

const createTempDbUrl = () => makeTempDb("maple-github-jwt-", createdTempDirs)

const makeLayer = (cfgOverride: Partial<ReturnType<typeof fullGithubConfig>> = {}) => {
	const { url } = createTempDbUrl()
	const cfg = { ...fullGithubConfig(url), ...cfgOverride }
	return GithubAppJwtService.layer.pipe(Layer.provide(makeBaseLayer(cfg)))
}

describe("GithubAppJwtService", () => {
	describe("resolveConfig", () => {
		it("succeeds when every required GITHUB_APP_* var is set", async () => {
			const config = await Effect.runPromise(
				Effect.gen(function* () {
					const svc = yield* GithubAppJwtService
					return yield* svc.resolveConfig
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(config.appId).toBe("999999")
			expect(config.appSlug).toBe("maple-test")
			expect(config.privateKeyPem).toContain("BEGIN PRIVATE KEY")
		})

		it.each([
			["appId", { appId: undefined }],
			["appSlug", { appSlug: undefined }],
			["privateKeyPem", { privateKeyPem: undefined }],
			["webhookSecret", { webhookSecret: undefined }],
		])("fails with GithubValidationError when %s is missing", async (_label, override) => {
			const exit = await Effect.runPromiseExit(
				Effect.gen(function* () {
					const svc = yield* GithubAppJwtService
					return yield* svc.resolveConfig
				}).pipe(Effect.provide(makeLayer(override))),
			)
			expect(Exit.isFailure(exit)).toBe(true)
		})

		it("strips literal \\n sequences from private key", async () => {
			const escaped = testRsaKey().pem.replace(/\n/g, "\\n")
			const config = await Effect.runPromise(
				Effect.gen(function* () {
					const svc = yield* GithubAppJwtService
					return yield* svc.resolveConfig
				}).pipe(Effect.provide(makeLayer({ privateKeyPem: escaped }))),
			)
			expect(config.privateKeyPem).toContain("\n")
			expect(config.privateKeyPem).not.toContain("\\n")
		})
	})

	describe("mintAppJwt", () => {
		it("produces a 3-part JWT verifiable with the public key", async () => {
			const jwt = await Effect.runPromise(
				Effect.gen(function* () {
					const svc = yield* GithubAppJwtService
					return yield* svc.mintAppJwt
				}).pipe(Effect.provide(makeLayer())),
			)
			const parts = jwt.split(".")
			expect(parts).toHaveLength(3)

			const decode = (b64url: string) =>
				Buffer.from(
					b64url.replace(/-/g, "+").replace(/_/g, "/") +
						"=".repeat((4 - (b64url.length % 4)) % 4),
					"base64",
				).toString()

			const header = JSON.parse(decode(parts[0]!))
			const payload = JSON.parse(decode(parts[1]!))
			expect(header).toEqual({ alg: "RS256", typ: "JWT" })
			expect(payload.iss).toBe("999999")
			expect(payload.exp).toBeGreaterThan(payload.iat)
			expect(payload.exp - payload.iat).toBeLessThanOrEqual(600)

			const verifier = createVerify("RSA-SHA256")
			verifier.update(`${parts[0]}.${parts[1]}`)
			verifier.end()
			const sigBytes = Buffer.from(
				parts[2]!.replace(/-/g, "+").replace(/_/g, "/") +
					"=".repeat((4 - (parts[2]!.length % 4)) % 4),
				"base64",
			)
			const publicKey = createPublicKey(testRsaKey().publicKey)
			expect(verifier.verify(publicKey, sigBytes)).toBe(true)
		})
	})

	describe("verifyWebhookSignature", () => {
		const signWith = (secret: string, body: ArrayBuffer) =>
			"sha256=" +
			createHmac("sha256", secret)
				.update(Buffer.from(body))
				.digest("hex")

		const body = new TextEncoder().encode('{"hello":"world"}').buffer as ArrayBuffer

		it("returns true for a valid signature", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const svc = yield* GithubAppJwtService
					const sig = signWith("test-webhook-secret-1234567890", body)
					return yield* svc.verifyWebhookSignature(sig, body)
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(result).toBe(true)
		})

		it("returns false for a wrong-secret signature", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const svc = yield* GithubAppJwtService
					const sig = signWith("not-the-real-secret", body)
					return yield* svc.verifyWebhookSignature(sig, body)
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(result).toBe(false)
		})

		it("returns false when header is missing", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const svc = yield* GithubAppJwtService
					return yield* svc.verifyWebhookSignature(undefined, body)
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(result).toBe(false)
		})

		it("returns false when header lacks sha256= prefix", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const svc = yield* GithubAppJwtService
					return yield* svc.verifyWebhookSignature("md5=abc", body)
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(result).toBe(false)
		})

		it("fails with validation error when hex is malformed", async () => {
			const exit = await Effect.runPromiseExit(
				Effect.gen(function* () {
					const svc = yield* GithubAppJwtService
					return yield* svc.verifyWebhookSignature("sha256=not-hex!!!", body)
				}).pipe(Effect.provide(makeLayer())),
			)
			expect(Exit.isFailure(exit)).toBe(true)
		})
	})

	describe("invalidateInstallationToken", () => {
		it("does not throw when no token is cached", async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const svc = yield* GithubAppJwtService
					yield* svc.invalidateInstallationToken(42)
				}).pipe(Effect.provide(makeLayer())),
			)
		})
	})
})
