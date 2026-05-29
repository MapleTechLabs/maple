// Resolves bundled SPA assets for the local server. Two sources, in order:
//   1. `embeddedAssets` — baked into the `maple` binary at build time (compiled).
//   2. apps/local-ui/dist on disk — the dev fallback (`bun run … start`).
// Returns `undefined` when no SPA is available (API-only mode).

import { existsSync, readFileSync } from "node:fs"
import { join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import type { AssetResolver } from "./serve"
import { embeddedAssets } from "./ui-embed.gen"

const MIME: Record<string, string> = {
	html: "text/html",
	js: "text/javascript",
	mjs: "text/javascript",
	css: "text/css",
	json: "application/json",
	map: "application/json",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	ico: "image/x-icon",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	txt: "text/plain",
	wasm: "application/wasm",
}

const mimeFor = (path: string): string => MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream"

export function resolveUiAssets(): AssetResolver | undefined {
	if (embeddedAssets) {
		const assets = embeddedAssets
		return (path) => {
			const hit = assets.get(path)
			return hit ? { body: hit.data, contentType: hit.contentType } : undefined
		}
	}

	// Dev: serve apps/local-ui/dist if it has been built.
	const distDir = fileURLToPath(new URL("../../../local-ui/dist/", import.meta.url))
	if (!existsSync(distDir)) return undefined
	return (path) => {
		const file = normalize(join(distDir, path))
		if (!file.startsWith(distDir) || !existsSync(file)) return undefined
		return { body: readFileSync(file), contentType: mimeFor(path) }
	}
}
