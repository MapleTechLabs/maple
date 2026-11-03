import { describe, it } from "@effect/vitest"
import { ok, strictEqual } from "node:assert"
import { spawnSync } from "node:child_process"
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Record as Rec, String as Str } from "effect"
import { installerPublicKey, signReleaseManifest } from "../../../../scripts/sign-local-release"
import {
	MAPLE_RELEASE_PUBLIC_KEY,
	parseChecksumManifest,
	releaseChecksum,
	releaseSignatureNotice,
	releaseVerificationFailure,
	verifyReleaseManifest,
} from "./release-signature"

// Throwaway keys generated per run; the real signing key never touches tests.
const keypair = () => {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519")
	return {
		privateKey,
		privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
		spki: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
	}
}
const signB64 = (bytes: Uint8Array, key: KeyObject) => sign(null, bytes, key).toString("base64")

const BUNDLE = "maple-v1.2.3-aarch64-apple-darwin.tar.gz"
const HASH = "8d63fd5826acba7826d5b8e607c4255b010e1f01fc7a2b62528fa490a76adff8"
const manifestFor = (name: string) => new TextEncoder().encode(`${HASH}  ${name}\n`)
const MANIFEST = manifestFor(BUNDLE)
const key = keypair()
const SIGNATURE = signB64(MANIFEST, key.privateKey)

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url))

describe("verifyReleaseManifest", () => {
	it("accepts a valid signature over the exact bytes", async () => {
		strictEqual(await Effect.runPromise(verifyReleaseManifest(MANIFEST, SIGNATURE, key.spki)), "verified")
		// The `.sig` asset ends in a newline.
		strictEqual(
			await Effect.runPromise(verifyReleaseManifest(MANIFEST, `${SIGNATURE}\n`, key.spki)),
			"verified",
		)
	})

	it("rejects a tampered manifest", async () => {
		const tampered = new TextEncoder().encode(`${Str.replace(/^8/, "9")(HASH)}  ${BUNDLE}\n`)
		const error = await Effect.runPromise(
			Effect.flip(verifyReleaseManifest(tampered, SIGNATURE, key.spki)),
		)
		strictEqual(error._tag, "@maple/cli/ReleaseSignatureInvalid")
		ok(error._tag === "@maple/cli/ReleaseSignatureInvalid" && error.reason === "mismatch")
	})

	it("rejects a signature from another key", async () => {
		const error = await Effect.runPromise(
			Effect.flip(verifyReleaseManifest(MANIFEST, SIGNATURE, keypair().spki)),
		)
		strictEqual(error._tag, "@maple/cli/ReleaseSignatureInvalid")
	})

	it("fails on a missing signature once a key is embedded", async () => {
		for (const missing of [undefined, "", "  \n"]) {
			const error = await Effect.runPromise(
				Effect.flip(verifyReleaseManifest(MANIFEST, missing, key.spki)),
			)
			strictEqual(error._tag, "@maple/cli/ReleaseSignatureMissing")
		}
	})

	it("rejects a malformed signature or public key", async () => {
		const badSig = await Effect.runPromise(
			Effect.flip(verifyReleaseManifest(MANIFEST, "not base64!", key.spki)),
		)
		ok(badSig._tag === "@maple/cli/ReleaseSignatureInvalid" && badSig.reason === "malformed-signature")

		const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
			.publicKey.export({ format: "der", type: "spki" })
			.toString("base64")
		for (const publicKey of ["garbage", rsa]) {
			const badKey = await Effect.runPromise(
				Effect.flip(verifyReleaseManifest(MANIFEST, SIGNATURE, publicKey)),
			)
			ok(
				badKey._tag === "@maple/cli/ReleaseSignatureInvalid" &&
					badKey.reason === "malformed-public-key",
			)
		}
	})

	it("skips verification while no key is embedded", async () => {
		strictEqual(await Effect.runPromise(verifyReleaseManifest(MANIFEST, undefined, "")), "unconfigured")
		strictEqual(await Effect.runPromise(verifyReleaseManifest(MANIFEST, "junk", "")), "unconfigured")
	})
})

describe("releaseChecksum", () => {
	const input = {
		manifest: MANIFEST,
		signature: SIGNATURE,
		bundleName: BUNDLE,
		skipSignature: false,
		publicKey: key.spki,
	}

	it("returns the checksum of an authenticated manifest", async () => {
		const result = await Effect.runPromise(releaseChecksum(input))
		strictEqual(result.sha256, HASH)
		strictEqual(result.signature, "verified")
	})

	it("rejects a validly signed manifest for another bundle", async () => {
		const other = manifestFor("maple-v1.0.0-aarch64-apple-darwin.tar.gz")
		const error = await Effect.runPromise(
			Effect.flip(
				releaseChecksum({ ...input, manifest: other, signature: signB64(other, key.privateKey) }),
			),
		)
		strictEqual(error._tag, "@maple/cli/ReleaseManifestInvalid")
		ok(Str.includes("maple-v1.0.0")(error.message))
	})

	it("requires a signed manifest to name its bundle", async () => {
		const bare = new TextEncoder().encode(`${HASH}\n`)
		const error = await Effect.runPromise(
			Effect.flip(
				releaseChecksum({ ...input, manifest: bare, signature: signB64(bare, key.privateKey) }),
			),
		)
		strictEqual(error._tag, "@maple/cli/ReleaseManifestInvalid")
	})

	it("accepts a bare pre-signing manifest while no key is embedded", async () => {
		const bare = new TextEncoder().encode(`${HASH}\n`)
		const result = await Effect.runPromise(
			releaseChecksum({ ...input, manifest: bare, signature: undefined, publicKey: "" }),
		)
		strictEqual(result.sha256, HASH)
		strictEqual(result.signature, "unconfigured")
	})

	it("skips the signature, not the manifest, with the escape hatch", async () => {
		const result = await Effect.runPromise(
			releaseChecksum({ ...input, signature: undefined, skipSignature: true }),
		)
		strictEqual(result.signature, "skipped")
		strictEqual(result.sha256, HASH)
		const wrongBundle = await Effect.runPromise(
			Effect.flip(
				releaseChecksum({ ...input, bundleName: "maple-v9.9.9-x.tar.gz", skipSignature: true }),
			),
		)
		strictEqual(wrongBundle._tag, "@maple/cli/ReleaseManifestInvalid")
	})
})

describe("parseChecksumManifest", () => {
	it("reads sha256sum text and binary lines", async () => {
		const text = await Effect.runPromise(parseChecksumManifest(`${Str.toUpperCase(HASH)}  ${BUNDLE}\r\n`))
		strictEqual(text.sha256, HASH)
		strictEqual(text.fileName, BUNDLE)
		strictEqual((await Effect.runPromise(parseChecksumManifest(`${HASH} *${BUNDLE}`))).fileName, BUNDLE)
	})

	it("rejects anything but one sha256 line", async () => {
		for (const bad of ["", "abc  x.tar.gz", `${HASH}  a\n${HASH}  b\n`]) {
			const error = await Effect.runPromise(Effect.flip(parseChecksumManifest(bad)))
			strictEqual(error._tag, "@maple/cli/ReleaseManifestInvalid")
		}
	})
})

describe("user-facing text", () => {
	it("names the escape hatch only for signature failures", async () => {
		const missing = await Effect.runPromise(
			Effect.flip(verifyReleaseManifest(MANIFEST, undefined, key.spki)),
		)
		ok(Str.includes("--insecure-skip-signature")(releaseVerificationFailure(missing, BUNDLE)))
		const manifest = await Effect.runPromise(Effect.flip(parseChecksumManifest("nope")))
		ok(!Str.includes("--insecure-skip-signature")(releaseVerificationFailure(manifest, BUNDLE)))
	})

	it("prints a notice only when the signature was not checked", () => {
		strictEqual(releaseSignatureNotice("verified"), undefined)
		ok(releaseSignatureNotice("unconfigured")?.includes("no release public key"))
		ok(releaseSignatureNotice("skipped")?.includes("--insecure-skip-signature"))
	})
})

describe("embedded release public key", () => {
	it("matches scripts/install.sh", () => {
		// oxlint-disable-next-line test-slop/no-source-text-assertions -- the shell installer embeds the same key; no shared source.
		const installer = installerPublicKey(readFileSync(join(REPO_ROOT, "scripts/install.sh"), "utf8"))
		strictEqual(installer, MAPLE_RELEASE_PUBLIC_KEY)
	})

	it("is an Ed25519 key", async () => {
		const error = await Effect.runPromise(
			Effect.flip(verifyReleaseManifest(MANIFEST, SIGNATURE, MAPLE_RELEASE_PUBLIC_KEY)),
		)
		// A throwaway signature must be a mismatch, never a malformed key.
		ok(error._tag === "@maple/cli/ReleaseSignatureInvalid" && error.reason === "mismatch")
	})
})

describe("scripts/sign-local-release.ts", () => {
	const signing = {
		manifest: MANIFEST,
		privateKeyPem: key.privatePem,
		embeddedPublicKey: key.spki,
		installerPublicKey: key.spki,
		required: true,
	}

	it("round-trips through the binary's verifier", async () => {
		const outcome = await Effect.runPromise(signReleaseManifest(signing))
		strictEqual(outcome.warning, undefined)
		const result = await Effect.runPromise(
			releaseChecksum({
				manifest: MANIFEST,
				signature: outcome.signature,
				bundleName: BUNDLE,
				skipSignature: false,
				publicKey: key.spki,
			}),
		)
		strictEqual(result.signature, "verified")
	})

	it("refuses a key that does not match the embedded public key", async () => {
		const error = await Effect.runPromise(
			Effect.flip(signReleaseManifest({ ...signing, privateKeyPem: keypair().privatePem })),
		)
		ok(Str.includes("does not match")(error.message))
	})

	it("fails a publishing run without the secret once a key is embedded", async () => {
		const error = await Effect.runPromise(
			Effect.flip(signReleaseManifest({ ...signing, privateKeyPem: undefined })),
		)
		ok(Str.includes("MAPLE_RELEASE_SIGNING_KEY is not set")(error.message))
		const notRequired = await Effect.runPromise(
			signReleaseManifest({ ...signing, privateKeyPem: undefined, required: false }),
		)
		strictEqual(notRequired.signature, undefined)
	})

	it("publishes unsigned with a warning before the key is provisioned", async () => {
		const outcome = await Effect.runPromise(
			signReleaseManifest({
				...signing,
				privateKeyPem: "",
				embeddedPublicKey: "",
				installerPublicKey: "",
			}),
		)
		strictEqual(outcome.signature, undefined)
		ok(outcome.warning !== undefined)
	})

	it("refuses installer drift, bare manifests, and non-Ed25519 keys", async () => {
		const drift = await Effect.runPromise(
			Effect.flip(signReleaseManifest({ ...signing, installerPublicKey: "" })),
		)
		ok(Str.includes("differ")(drift.message))
		const bare = await Effect.runPromise(
			Effect.flip(signReleaseManifest({ ...signing, manifest: new TextEncoder().encode(`${HASH}\n`) })),
		)
		ok(Str.includes("must name its bundle")(bare.message))
		const rsaPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
			.privateKey.export({ format: "pem", type: "pkcs8" })
			.toString()
		const rsa = await Effect.runPromise(
			Effect.flip(signReleaseManifest({ ...signing, privateKeyPem: rsaPem })),
		)
		ok(Str.includes("expected ed25519")(rsa.message))
		const junk = await Effect.runPromise(
			Effect.flip(
				signReleaseManifest({ ...signing, privateKeyPem: "-----BEGIN PRIVATE KEY-----\nnope" }),
			),
		)
		ok(Str.includes("not a valid PEM")(junk.message))
	})

	it("CLI: a non-publishing run without the secret warns and writes no .sig", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-sign-"))
		const manifestPath = join(dir, BUNDLE + ".sha256")
		writeFileSync(manifestPath, MANIFEST)
		const env = Rec.fromEntries(
			Object.entries({ ...process.env, MAPLE_RELEASE_SIGNING_REQUIRED: "0" }).filter(
				([key]) => key !== "MAPLE_RELEASE_SIGNING_KEY",
			),
		)
		const run = spawnSync(
			process.execPath,
			[join(REPO_ROOT, "scripts/sign-local-release.ts"), manifestPath],
			{
				env,
				encoding: "utf8",
			},
		)
		strictEqual(run.status, 0, run.stderr)
		ok(Str.includes("::warning::")(run.stdout))
		strictEqual(existsSync(`${manifestPath}.sig`), false)
		rmSync(dir, { recursive: true, force: true })
	})
})
