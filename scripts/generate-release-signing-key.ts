#!/usr/bin/env bun
/**
 * Generate the Ed25519 keypair that signs local-binary releases. Run once, by a
 * maintainer, on a trusted machine. See docs/local-mode.md "Release signing".
 *
 *   bun scripts/generate-release-signing-key.ts <private-key-path>
 *
 * Writes the PKCS#8 PEM private key to <private-key-path> (mode 0600, never
 * overwriting) and prints the public key plus the provisioning steps.
 */
import { generateKeyPairSync } from "node:crypto"
import { existsSync, writeFileSync } from "node:fs"

const path = process.argv[2]
if (path === undefined || path === "") {
	console.error("usage: bun scripts/generate-release-signing-key.ts <private-key-path>")
	process.exit(1)
}
if (existsSync(path)) {
	console.error(`refusing to overwrite ${path}; pick a new path or delete it first`)
	process.exit(1)
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519")
// "wx" fails instead of clobbering if the path appeared since the check above.
writeFileSync(path, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" })
const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64")

console.log(`Wrote the private key to ${path} (mode 0600).

Public key (base64 SPKI):

  ${spki}

Next steps, in order:

  1. Store the private key as the release workflow secret:
       gh secret set MAPLE_RELEASE_SIGNING_KEY < ${path}
  2. Paste the public key into both places (a test keeps them equal):
       apps/cli/src/core/release-signature.ts   export const MAPLE_RELEASE_PUBLIC_KEY = "${spki}"
       scripts/install.sh                       release_public_key="${spki}"
     Merge that before the next release tag. From then on, tag releases fail
     unless the secret is set and matches this key.
  3. Store ${path} in your password manager. Losing it means shipping a new
     key, and binaries that embed the old one will reject every later release.
  4. Delete the file:
       rm ${path}
`)
