// Release authenticity for `maple update`. The release workflow signs each
// bundle's `.sha256` manifest with an Ed25519 key (scripts/sign-local-release.ts);
// this module checks that signature against the public key baked into the binary.
import { createPublicKey, verify, type KeyObject } from "node:crypto"
import { Effect, Schema } from "effect"

/**
 * Base64 SPKI (DER) of the Ed25519 release public key. Empty until the key is
 * provisioned (docs/local-mode.md "Release signing"). scripts/install.sh embeds
 * the same value as `release_public_key`; release-signature.test.ts enforces it.
 */
export const MAPLE_RELEASE_PUBLIC_KEY = ""

const SignatureFailureReason = Schema.Literals(["malformed-public-key", "malformed-signature", "mismatch"])

export class ReleaseSignatureMissing extends Schema.TaggedError<ReleaseSignatureMissing>()(
	"@maple/cli/ReleaseSignatureMissing",
	{ message: Schema.String },
) {}

export class ReleaseSignatureInvalid extends Schema.TaggedError<ReleaseSignatureInvalid>()(
	"@maple/cli/ReleaseSignatureInvalid",
	{ message: Schema.String, reason: SignatureFailureReason },
) {}

/** The manifest is unreadable, or does not name the bundle being installed. */
export class ReleaseManifestInvalid extends Schema.TaggedError<ReleaseManifestInvalid>()(
	"@maple/cli/ReleaseManifestInvalid",
	{ message: Schema.String, rawManifest: Schema.String },
) {}

export type ReleaseVerificationError =
	| ReleaseSignatureMissing
	| ReleaseSignatureInvalid
	| ReleaseManifestInvalid

/** `unconfigured`: this build has no public key yet, so nothing was checked. */
export type ManifestVerification = "verified" | "unconfigured"
/** `skipped`: the user passed `--insecure-skip-signature`. */
export type ReleaseSignatureStatus = ManifestVerification | "skipped"

const VERIFIED: ManifestVerification = "verified"
const UNCONFIGURED: ManifestVerification = "unconfigured"
const SKIPPED: ReleaseSignatureStatus = "skipped"

// An Ed25519 signature is 64 bytes: 86 base64 characters plus "==" padding.
const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/

const parsePublicKey = (spkiBase64: string): Effect.Effect<KeyObject, ReleaseSignatureInvalid> => {
	const malformed = new ReleaseSignatureInvalid({
		reason: "malformed-public-key",
		message: "the release public key embedded in this build is malformed",
	})
	return Effect.try({
		try: () => createPublicKey({ key: Buffer.from(spkiBase64, "base64"), format: "der", type: "spki" }),
		catch: () => malformed,
	}).pipe(
		Effect.filterOrFail(
			(key: KeyObject) => key.asymmetricKeyType === "ed25519",
			() => malformed,
		),
	)
}

/**
 * Check `signatureBase64` (the `.sig` asset) over the exact manifest bytes.
 * Succeeds with `unconfigured` when no public key is embedded; otherwise a
 * missing or non-matching signature fails.
 */
export const verifyReleaseManifest = (
	manifestBytes: Uint8Array,
	signatureBase64: string | undefined,
	publicKey: string = MAPLE_RELEASE_PUBLIC_KEY,
): Effect.Effect<ManifestVerification, ReleaseSignatureMissing | ReleaseSignatureInvalid> => {
	if (publicKey.trim() === "") return Effect.succeed(UNCONFIGURED)
	return Effect.gen(function* () {
		const key = yield* parsePublicKey(publicKey.trim())
		const encoded = signatureBase64?.trim() ?? ""
		if (encoded === "") {
			return yield* new ReleaseSignatureMissing({ message: "the release has no signature" })
		}
		if (!SIGNATURE_BASE64.test(encoded)) {
			return yield* new ReleaseSignatureInvalid({
				reason: "malformed-signature",
				message: "the release signature is not a base64 Ed25519 signature",
			})
		}
		const matches = yield* Effect.try({
			try: () => verify(null, manifestBytes, key, Buffer.from(encoded, "base64")),
			catch: () =>
				new ReleaseSignatureInvalid({
					reason: "malformed-signature",
					message: "the release signature could not be checked",
				}),
		})
		if (!matches) {
			return yield* new ReleaseSignatureInvalid({
				reason: "mismatch",
				message: "the release signature does not match its checksum manifest",
			})
		}
		return VERIFIED
	})
}

export interface ChecksumManifest {
	readonly sha256: string
	/** Bundle the checksum is for; absent in manifests from before signing. */
	readonly fileName: string | undefined
}

// `sha256sum` / `shasum -a 256` output for one file: "<hex>  <name>", where a
// "*" before the name marks binary mode. A bare "<hex>" is the pre-signing form.
const MANIFEST_LINE = /^([0-9a-fA-F]{64})(?:[ \t]+\*?(\S+))?$/

export const parseChecksumManifest = (
	text: string,
): Effect.Effect<ChecksumManifest, ReleaseManifestInvalid> => {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
	const match = lines.length === 1 ? MANIFEST_LINE.exec(lines[0] ?? "") : null
	if (match === null) {
		return Effect.fail(
			new ReleaseManifestInvalid({
				message: "the checksum manifest is not a single sha256 line",
				rawManifest: text.slice(0, 200),
			}),
		)
	}
	return Effect.succeed({ sha256: (match[1] ?? "").toLowerCase(), fileName: match[2] })
}

export interface ReleaseChecksumInput {
	/** Exact bytes of `<bundle>.sha256`. */
	readonly manifest: Uint8Array
	/** Contents of `<bundle>.sha256.sig`, or undefined when the release has none. */
	readonly signature: string | undefined
	/** Tarball the manifest must cover, e.g. `maple-v0.6.0-aarch64-apple-darwin.tar.gz`. */
	readonly bundleName: string
	readonly skipSignature: boolean
	/** Test seam; defaults to MAPLE_RELEASE_PUBLIC_KEY. */
	readonly publicKey?: string
}

export interface ReleaseChecksum {
	readonly sha256: string
	readonly signature: ReleaseSignatureStatus
}

/**
 * The bundle's expected sha256, trusted only after its manifest is authenticated.
 * A verified manifest must name `bundleName`, so a validly signed manifest from
 * another version or platform cannot vouch for this download.
 */
export const releaseChecksum = (
	input: ReleaseChecksumInput,
): Effect.Effect<ReleaseChecksum, ReleaseVerificationError> =>
	Effect.gen(function* () {
		const signature = input.skipSignature
			? SKIPPED
			: yield* verifyReleaseManifest(input.manifest, input.signature, input.publicKey)
		const text = new TextDecoder().decode(input.manifest)
		const manifest = yield* parseChecksumManifest(text)
		const namesBundle = manifest.fileName === input.bundleName
		if (manifest.fileName === undefined ? signature === VERIFIED : !namesBundle) {
			return yield* new ReleaseManifestInvalid({
				message:
					manifest.fileName === undefined
						? `the signed checksum manifest does not name ${input.bundleName}`
						: `the checksum manifest is for ${manifest.fileName}, not ${input.bundleName}`,
				rawManifest: text.slice(0, 200),
			})
		}
		return { sha256: manifest.sha256, signature }
	})

/** User-facing text for a failed verification of `bundleName`. */
export const releaseVerificationFailure = (error: ReleaseVerificationError, bundleName: string): string =>
	error._tag === "@maple/cli/ReleaseManifestInvalid"
		? `refusing to install ${bundleName}: ${error.message}`
		: `refusing to install ${bundleName}: ${error.message}. If you trust this release anyway, re-run with --insecure-skip-signature (the SHA-256 checksum is still checked)`

/** One-line notice for an update whose signature was not checked, if any. */
export const releaseSignatureNotice = (status: ReleaseSignatureStatus): string | undefined => {
	if (status === "unconfigured") {
		return "release signature not checked: this build has no release public key (checksum verified)"
	}
	if (status === "skipped") {
		return "release signature not checked (--insecure-skip-signature); only the SHA-256 checksum was verified"
	}
	return undefined
}
