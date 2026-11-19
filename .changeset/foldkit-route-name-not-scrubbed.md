---
"@maple-dev/effect-sdk": patch
---

`MapleFoldkit.make`: a `routeName` result names the navigation span as is. It no longer goes
through `privacy.sanitizeUrl`, which turned a label like `Home` into `[url]` when the sanitizer
rejects anything that is not a URL. Without `routeName`, the path fallback is still sanitized.
