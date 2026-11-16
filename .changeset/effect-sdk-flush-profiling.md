---
"@maple-dev/effect-sdk": minor
---

`MapleFlush.make({ profiling: true })` runs the continuous CPU profiler too, on the same endpoint
and key as its flushes, and starts no second profiler when its `layer` is built again while one
runs. An inspector that takes a session and never answers no longer holds the app's startup up:
after 5 seconds profiling turns off with one warning.
