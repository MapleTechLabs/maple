#!/usr/bin/env bun
/**
 * Sign a local-binary release manifest (`<bundle>.tar.gz.sha256`) with the
 * Ed25519 release key, writing `<manifest>.sig`: the base64 signature over the
 * exact file bytes. `maple update` and scripts/install.sh check it against
 * MAPLE_RELEASE_PUBLIC_KEY. See docs/local-mode.md "Release signing".
 *
 *   MAPLE_RELEASE_SIGNING_KEY="$(cat key.pem)" bun scripts/sign-local-release.ts <manifest>
 *
 * MAPLE_RELEASE_SIGNING_REQUIRED=1 (set on publishing runs) makes a missing key
 * fatal once a public key is embedded, so a signed channel never silently ships
 * an unsigned release. Before the key is provisioned, a missing key is a warning.
 */
import { createPrivateKey, createPublicKey, sign } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Console, Effect, Schema } from "effect"
import {
	MAPLE_RELEASE_PUBLIC_KEY,
	parseChecksumManifest,
	verifyReleaseManifest,
} from "../apps/cli/src/core/release-signature"

export class ReleaseSigningError extends Schema.TaggedError<ReleaseSigningError>()(
	"@maple/scripts/ReleaseSigningError",
	{ message: Schema.String },
) {}

export interface SigningInput {
	/** Exact bytes of the `.sha256` manifest. */
	readonly manifest: Uint8Array
	/** PKCS#8 PEM; undefined or empty when the secret is not configured. */
	readonly privateKeyPem: string | undefined
	/** MAPLE_RELEASE_PUBLIC_KEY as compiled into the binary. */
	readonly embeddedPublicKey: string
	/** `release_public_key` from scripts/install.sh. */
	readonly installerPublicKey: string
	readonly required: boolean
}

export interface SigningOutcome {
	/** Base64 signature for `<manifest>.sig`; undefined when signing was skipped. */
	readonly signature: string | undefined
	readonly warning: string | undefined
}

const failWith = (message: string) => Effect.fail(new ReleaseSigningError({ message }))

export const signReleaseManifest = (
	input: SigningInput,
): Effect.Effect<SigningOutcome, ReleaseSigningError> =>
	Effect.gen(function* () {
		const embedded = input.embeddedPublicKey.trim()
		if (embedded !== input.installerPublicKey.trim()) {
			return yield* failWith(
				"MAPLE_RELEASE_PUBLIC_KEY in apps/cli/src/core/release-signature.ts and release_public_key in scripts/install.sh differ",
			)
		}
		const manifest = yield* parseChecksumManifest(new TextDecoder().decode(input.manifest)).pipe(
			Effect.mapError((error) => new ReleaseSigningError({ message: error.message })),
		)
		if (manifest.fileName === undefined) {
			return yield* failWith(
				"the manifest must name its bundle (`<sha256>  <file>`), or a signed one could vouch for any release",
			)
		}

		const pem = input.privateKeyPem?.trim() ?? ""
		if (pem === "") {
			if (embedded === "") {
				return {
					signature: undefined,
					warning:
						"MAPLE_RELEASE_SIGNING_KEY is not set and no release public key is embedded yet; publishing unsigned",
				}
			}
			if (input.required) {
				return yield* failWith(
					'MAPLE_RELEASE_SIGNING_KEY is not set, but binaries embed MAPLE_RELEASE_PUBLIC_KEY and will reject an unsigned release. Configure the secret (docs/local-mode.md "Release signing")',
				)
			}
			return {
				signature: undefined,
				warning:
					"MAPLE_RELEASE_SIGNING_KEY is not set; this build is unsigned (not a publishing run)",
			}
		}

		// Parse and sign; error messages never echo key material.
		const signed = yield* Effect.try({
			try: () => {
				const privateKey = createPrivateKey(pem)
				const publicKey = createPublicKey(privateKey)
					.export({ format: "der", type: "spki" })
					.toString("base64")
				return { privateKey, publicKey }
			},
			catch: () =>
				new ReleaseSigningError({
					message: "MAPLE_RELEASE_SIGNING_KEY is not a valid PEM private key",
				}),
		})
		if (signed.privateKey.asymmetricKeyType !== "ed25519") {
			return yield* failWith(
				`MAPLE_RELEASE_SIGNING_KEY is a ${signed.privateKey.asymmetricKeyType ?? "unknown"} key, expected ed25519`,
			)
		}
		if (embedded !== "" && signed.publicKey !== embedded) {
			return yield* failWith(
				"MAPLE_RELEASE_SIGNING_KEY does not match MAPLE_RELEASE_PUBLIC_KEY; every binary would reject this release",
			)
		}
		const signature = yield* Effect.try({
			try: () => sign(null, input.manifest, signed.privateKey).toString("base64"),
			catch: () => new ReleaseSigningError({ message: "signing the manifest failed" }),
		})
		// Round-trip through the binary's own verifier before anything is published.
		yield* verifyReleaseManifest(input.manifest, signature, signed.publicKey).pipe(
			Effect.mapError(
				(error) => new ReleaseSigningError({ message: `self-check failed: ${error.message}` }),
			),
		)
		return {
			signature,
			warning:
				embedded === ""
					? "signed, but no release public key is embedded yet, so clients will not check this signature"
					: undefined,
		}
	})

/** `release_public_key="..."` from scripts/install.sh. */
export const installerPublicKey = (installScript: string): string | undefined =>
	/^release_public_key="([A-Za-z0-9+/=]*)"$/m.exec(installScript)?.[1]

const main = Effect.gen(function* () {
	const manifestPath = process.argv[2]
	if (manifestPath === undefined) {
		return yield* failWith("usage: bun scripts/sign-local-release.ts <bundle>.tar.gz.sha256")
	}
	const read = (path: string) =>
		Effect.try({
			try: () => readFileSync(path),
			catch: () => new ReleaseSigningError({ message: `could not read ${path}` }),
		})
	const manifest = yield* read(manifestPath)
	const installer = installerPublicKey((yield* read(join(import.meta.dir, "install.sh"))).toString("utf8"))
	if (installer === undefined) {
		return yield* failWith('scripts/install.sh has no `release_public_key="..."` line')
	}
	const outcome = yield* signReleaseManifest({
		manifest,
		privateKeyPem: process.env.MAPLE_RELEASE_SIGNING_KEY,
		embeddedPublicKey: MAPLE_RELEASE_PUBLIC_KEY,
		installerPublicKey: installer,
		required: process.env.MAPLE_RELEASE_SIGNING_REQUIRED === "1",
	})
	if (outcome.warning !== undefined) yield* Console.log(`::warning::${outcome.warning}`)
	if (outcome.signature !== undefined) {
		const signature = outcome.signature
		yield* Effect.try({
			try: () => writeFileSync(`${manifestPath}.sig`, `${signature}\n`),
			catch: () => new ReleaseSigningError({ message: `could not write ${manifestPath}.sig` }),
		})
		yield* Console.log(`signed ${manifestPath} -> ${manifestPath}.sig`)
	}
})

if (import.meta.main) {
	await Effect.runPromise(
		main.pipe(
			Effect.catch((error) =>
				Console.error(`::error::${error.message}`).pipe(
					Effect.andThen(Effect.sync(() => (process.exitCode = 1))),
				),
			),
		),
	)
}
