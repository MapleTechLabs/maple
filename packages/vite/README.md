# @maple-dev/vite

A Vite plugin that uploads your build's source maps to [Maple](https://maple.dev), so error stacks
show your original files, functions and code instead of minified ones.

At the end of `vite build` it:

- turns on hidden source maps (`build.sourcemap: "hidden"`) when the setting is unset or off, so no
  public `sourceMappingURL` comment is written
- gives each built JS file a debug id
- moves the maps out of the deployed output into `.maple/sourcemaps/<outDir>`, so they are never served
- uploads them to Maple

If you deploy with Alchemy, use [`@maple-dev/alchemy`](https://www.npmjs.com/package/@maple-dev/alchemy)
instead: its `Maple.SourceMaps` resource uploads as part of the deploy.

## Install

```bash
npm install -D @maple-dev/vite
```

Needs Vite 6 or later. The plugin runs in Node.

## Usage

```typescript
// vite.config.ts
import { mapleSourceMaps } from "@maple-dev/vite"
import { defineConfig } from "vite"

export default defineConfig({
	plugins: [
		mapleSourceMaps({
			service: "web", // the service.name the app reports
			release: process.env.GITHUB_SHA, // its service.version
		}),
	],
})
```

In CI, set `MAPLE_API_KEY` to a Maple API key with the **Source maps** write scope
(`source_maps:write`), created by an engineer or admin under **Settings → Keys**:

```yaml
- run: npm run build
  env:
      MAPLE_API_KEY: ${{ secrets.MAPLE_API_KEY }}
```

The variable is `MAPLE_API_KEY`, not the `MAPLE_API_TOKEN` the Maple CLI reads.

Without a key, or without `service`, the plugin logs a warning and keeps the maps on disk, so a
local build works with no setup. Add `.maple` to your `.gitignore`.

## Options

| Option         | What it does                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `service`      | The `service.name` your app reports. Required to upload.                                                                          |
| `release`      | The `service.version` your app reports, such as a commit SHA. Required with `matchBy: "release"`. There is no default.            |
| `apiKey`       | The API key. Defaults to `MAPLE_API_KEY`.                                                                                         |
| `apiUrl`       | The Maple API base URL. Defaults to `MAPLE_API_URL`, then `https://api.maple.dev`.                                                |
| `urlPrefix`    | The path the files are served under, prepended to each file path. Set `static/` when `dist/app.js` is served as `/static/app.js`. |
| `matchBy`      | `"debugId"` (default) or `"release"`. See below.                                                                                  |
| `upload`       | Set `false` to only inject debug ids and move the maps, and upload them another way.                                              |
| `failOnError`  | Set `true` to fail the build when an upload fails. By default a failed upload logs a warning and the build finishes.              |
| `mapsDir`      | Where the maps go, relative to the Vite root. Defaults to `.maple/sourcemaps/<outDir basename>`, so `.maple/sourcemaps/dist`.     |
| `environments` | The Vite environments whose output is processed. Defaults to `["client"]`, the browser bundle.                                    |

## Matching maps to errors

The default, `matchBy: "debugId"`, files each map under the debug id its JS file registers at
runtime. [`@maple-dev/browser`](https://www.npmjs.com/package/@maple-dev/browser) 0.17.0 or later
reports those ids with each error, so the map is found whatever URL the file was served from.

Set `matchBy: "release"` when your telemetry reports no debug ids. Maps then upload without them
and are matched by `service`, `release` and file path, so `release` must equal the
`service.version` on your telemetry.

## Uploads

Maps upload four at a time. A request that gets a 429, a 5xx or no response is retried up to 4
times, with exponential backoff starting at 500 ms. Redirects are not followed, so the key is never
sent to another origin.

A map is skipped with a warning when:

- it is over 10 MiB
- it is an index map (one with `sections`)
- it maps no sources
- `matchBy: "release"` is set without a `release`
- its file has no debug id and no `release` is set

`failOnError` covers failed uploads and maps that cannot be read. A missing key or `service`, and
skipped maps, only warn.

## First deploy

On the first build with the plugin, a chunk whose hashed name did not change gets new contents,
because the debug id goes in after the file is named. A browser or CDN that cached that chunk may
serve the old copy for that one release. Later builds are deterministic.

## Docs

[maple.dev/docs/errors/source-maps](https://maple.dev/docs/errors/source-maps)
