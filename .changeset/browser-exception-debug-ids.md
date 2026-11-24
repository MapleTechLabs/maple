---
"@maple-dev/browser": minor
---

Exception events now carry `maple.exception.debug_ids`: for each script in the error's stack that registered a debug id (through `maple sourcemaps inject`, or Sentry's debug id tooling), its URL and id, so the matching source map is found by id rather than by file path. Absent when no script in the stack has one.
