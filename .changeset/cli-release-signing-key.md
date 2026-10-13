---
"@maple/cli": patch
---

Releases are now signed. `maple update` verifies each release's Ed25519 signature before it trusts the checksum, and the installer does the same (on macOS it needs `brew install openssl@3`).

To install a release from before signing, pass `--insecure-skip-signature` to `maple update` or set `MAPLE_SKIP_SIGNATURE=1` for the installer.
