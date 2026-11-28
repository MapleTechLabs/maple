# @maple-dev/vite

## 0.1.0

### Minor Changes

- 262e616: New package `@maple-dev/vite`: `mapleSourceMaps()` source maps for any Vite build, no Alchemy needed. It turns on hidden source maps, gives each built JS file a debug id, moves the maps out of the deployed output and uploads them to Maple at the end of `vite build`, with `MAPLE_API_KEY` (or `apiKey`). Without a key it warns and keeps the maps on disk; `failOnError` fails the build on a failed upload. `@maple-dev/alchemy` shares the same plugin core and upload planning, with no behaviour change.
