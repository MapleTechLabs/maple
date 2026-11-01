import { detectCloudflareWorker } from "@maple/domain/cloud-platform"
import { CloudflareIcon } from "../../components/icons"
import type { CloudPlatformAdapter } from "./types"
import { CLOUDFLARE_ACCENT_CLASS } from "./accents"
import { cloudflareDisplay } from "./cloudflare-display"

// Cloudflare Workers Observability annotations, detected by `@maple/domain/cloud-platform`
// (the same detector MCP `inspect_span` reads).

export const cloudflareAdapter: CloudPlatformAdapter = {
	id: "cloudflare",
	detect(attrs) {
		const worker = detectCloudflareWorker(attrs)
		if (worker === undefined) return null
		const display = cloudflareDisplay(worker)
		return {
			id: "cloudflare",
			label: "Cloudflare Worker",
			kind: "Worker",
			Icon: CloudflareIcon,
			accentClassName: CLOUDFLARE_ACCENT_CLASS,
			edge: display.edge,
			location: display.location,
			outcome: display.outcome,
			fields: display.fields,
		}
	},
}
