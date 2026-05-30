import path from "node:path"
import { Vite } from "alchemy/cloudflare"
import { resolveWorkerName, type MapleDomains, type MapleStage } from "@maple/infra/cloudflare"

export interface CreateLocalUiWorkerOptions {
	stage: MapleStage
	domains: MapleDomains
}

// The local-mode dashboard SPA. Deploying this to `local.maple.dev` decouples UI
// updates from `maple` binary releases — the binary points users here by default
// and embeds this same build only as the `--offline` fallback.
//
// It's a plain Vite SPA that builds flat to `dist/` (the `maple` binary embeds
// that same `dist/` via rust-embed — see `apps/cli/src/server/ui-assets.ts`).
// The `Vite` helper otherwise defaults its asset directory to `dist/client`
// whenever an `entrypoint` is set (the TanStack-Start layout), which doesn't
// exist here — so pin `assets` to `dist` to match the flat build.
export const createLocalUiWorker = async ({ stage, domains }: CreateLocalUiWorkerOptions) => {
	const worker = await Vite("local-ui", {
		name: resolveWorkerName("local-ui", stage),
		adopt: true,
		cwd: import.meta.dirname,
		entrypoint: path.join(import.meta.dirname, "src", "worker.ts"),
		assets: "dist",
		domains: domains.local ? [{ domainName: domains.local, adopt: true }] : undefined,
	})

	return worker
}
