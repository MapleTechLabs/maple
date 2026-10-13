---
"@maple/cli": patch
---

`maple update` now shows each step as it runs (manifest check, download, checksum, unpack, install) with a spinner, and the download gets a live progress bar with size and speed. Piped or CI output prints only the finished steps.
