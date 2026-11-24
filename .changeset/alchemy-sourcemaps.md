---
"@maple-dev/alchemy": minor
---

Automatic source map uploads. `@maple-dev/alchemy/vite` exports `mapleSourceMaps()`, a Vite plugin that turns on hidden source maps, gives each built JS file a debug id and moves the maps out of the deployed output into `.maple/sourcemaps/<outDir>` with a manifest. The new `Maple.SourceMaps` resource uploads them through `POST /v2/source_maps` after the build, again only when the maps changed; deleting it keeps the uploaded maps, which earlier releases still need. `MapleApiContract` gains `upload` for raw request bodies.
