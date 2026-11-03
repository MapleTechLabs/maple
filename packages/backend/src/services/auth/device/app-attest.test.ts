import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { makeSyntheticAttestation } from "@maple/backend/testing/app-attest-fixture"
import { type AppAttestInput, verifyAppAttestation } from "./app-attest"
import { sha256 } from "./jose"
import fixtures from "./fixtures/app-attest.json"

const REAL_APP_ID = "V8H6LQ9448.io.uebelacker.AppAttestExample"
// Inside both fixture leaves' validity windows (production leaf: 2024-02-06 to 2024-12-21).
const REAL_NOW = Date.UTC(2024, 5, 1)
const SYNTHETIC_APP_ID = "TEAMID1234.com.maple.mobile"
const NOW = Date.UTC(2026, 9, 24)

const realInput = (fixture: { attestation: string; keyId: string; challenge: string }): AppAttestInput => ({
	attestationObject: new Uint8Array(Buffer.from(fixture.attestation, "base64")),
	keyId: new Uint8Array(Buffer.from(fixture.keyId, "base64")),
	clientDataHash: sha256(new Uint8Array(Buffer.from(fixture.challenge, "base64"))),
	appId: REAL_APP_ID,
	allowDevelopment: false,
	nowMs: REAL_NOW,
})

const failureReason = async (input: AppAttestInput) => {
	const exit = await Effect.runPromiseExit(verifyAppAttestation(input))
	if (Exit.isSuccess(exit)) return "verified"
	const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
	return error?._tag === "Fail" ? error.error.reason : "defect"
}

const synthetic = async (overrides: Partial<Parameters<typeof makeSyntheticAttestation>[0]> = {}) => {
	const clientDataHash = sha256("challenge.jkt")
	const built = await makeSyntheticAttestation({ appId: SYNTHETIC_APP_ID, clientDataHash, ...overrides })
	return {
		attestationObject: built.attestationObject,
		keyId: built.keyId,
		clientDataHash,
		appId: SYNTHETIC_APP_ID,
		allowDevelopment: false,
		nowMs: NOW,
		rootCertificate: built.rootCertificate,
	} satisfies AppAttestInput
}

describe("App Attest verification against Apple's chain", () => {
	it("verifies a real production attestation", async () => {
		const result = await Effect.runPromise(verifyAppAttestation(realInput(fixtures.production)))
		expect(result.environment).toBe("production")
		expect(result.counter).toBe(0)
		expect(result.receipt?.length).toBeGreaterThan(0)
	})

	it("accepts a development attestation only where allowed", async () => {
		const input = realInput(fixtures.development)
		expect(await failureReason(input)).toBe("environment")
		const result = await Effect.runPromise(verifyAppAttestation({ ...input, allowDevelopment: true }))
		expect(result.environment).toBe("development")
	})

	it("rejects a different challenge", async () => {
		expect(
			await failureReason({
				...realInput(fixtures.production),
				clientDataHash: sha256("another challenge"),
			}),
		).toBe("nonce")
	})

	it("rejects another app's attestation", async () => {
		expect(
			await failureReason({ ...realInput(fixtures.production), appId: "V8H6LQ9448.com.example.other" }),
		).toBe("app_id")
	})

	it("rejects a key id the leaf does not certify", async () => {
		expect(
			await failureReason({ ...realInput(fixtures.production), keyId: sha256("some other key") }),
		).toBe("key_id")
	})

	it("rejects the chain once the leaf has expired", async () => {
		expect(await failureReason({ ...realInput(fixtures.production), nowMs: Date.UTC(2026, 0, 1) })).toBe(
			"chain",
		)
	})

	it("rejects Apple's chain under a different trust anchor", async () => {
		const other = await synthetic()
		expect(
			await failureReason({
				...realInput(fixtures.production),
				rootCertificate: other.rootCertificate,
			}),
		).toBe("chain")
	})
})

describe("App Attest verification steps on generated chains", () => {
	it("verifies a well-formed attestation under its own root", async () => {
		const result = await Effect.runPromise(verifyAppAttestation(await synthetic()))
		expect(result.environment).toBe("production")
	})

	it("rejects a chain that does not reach the trusted root", async () => {
		const input = await synthetic()
		const stranger = await synthetic()
		expect(await failureReason({ ...input, rootCertificate: stranger.rootCertificate })).toBe("chain")
	})

	it("rejects a leaf committing to another nonce", async () => {
		expect(await failureReason(await synthetic({ nonceOverride: sha256("not the nonce") }))).toBe("nonce")
	})

	it("rejects a non-zero counter", async () => {
		expect(await failureReason(await synthetic({ counter: 1 }))).toBe("counter")
	})

	it("rejects a credential id other than the key id", async () => {
		expect(
			await failureReason(await synthetic({ credentialIdOverride: sha256("other credential") })),
		).toBe("credential_id")
	})

	it("rejects bytes that are not an attestation object", async () => {
		expect(
			await failureReason({ ...(await synthetic()), attestationObject: new Uint8Array([1, 2, 3]) }),
		).toBe("format")
	})
})
