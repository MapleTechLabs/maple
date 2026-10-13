---
"@maple/cli": patch
---

Releases are now signed. `maple update` verifies each release's Ed25519 signature before it trusts the checksum, and the installer does the same.
