---
"@maple/cli": minor
---

Add `maple get`, `maple post`, `maple put`, `maple patch` and `maple api <method>` to call any Maple API endpoint as the logged-in user. `-d key=value` (or `key:=<json>`, with `a[b]` nesting) builds the query string or JSON body, `-H` adds headers, `--input` sends a raw JSON body, and `-i` prints the response status and headers.
