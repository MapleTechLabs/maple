import { CloudflareIcon } from "../../components/icons"
import type { CloudPlatformAdapter, CloudPlatformField } from "./types"
import { joinEdge, pickAttr } from "./types"

// Cloudflare Workers Observability annotations. Worker traces come from CF's
// native pipeline (`scope.name: workers-observability`), so they carry a
// `cloudflare.*` / `faas.*` / `geo.*` attribute set no other emitter sends.

export const cloudflareAdapter: CloudPlatformAdapter = {
	id: "cloudflare",
	detect(attrs) {
		// `cloud.platform` is the canonical Worker signal (exact match). The
		// fallback must check for a real cloudflare.* VALUE, never key presence:
		// the trimmed tree-view projection (buildProjectedMapExpr) emits the
		// requested keys with empty-string values for EVERY span, so a key-presence
		// check would flag every span as a Worker.
		const isWorker =
			attrs["cloud.platform"] === "cloudflare.workers" ||
			Object.entries(attrs).some(([k, v]) => k.startsWith("cloudflare.") && v.trim() !== "")
		if (!isWorker) return null

		const country = pickAttr(attrs, "geo.country.code")
		const city = pickAttr(attrs, "geo.locality.name")
		const outcome = pickAttr(attrs, "cloudflare.outcome")

		const scriptName = pickAttr(attrs, "cloudflare.script_name", "faas.name")
		const scriptVersion = pickAttr(attrs, "cloudflare.script_version.id", "faas.version")
		const model = pickAttr(attrs, "cloudflare.execution_model")
		const handler = pickAttr(attrs, "cloudflare.handler_type", "faas.trigger")
		const cpu = pickAttr(attrs, "cpu_time_ms")
		const wall = pickAttr(attrs, "wall_time_ms")
		const ttfb = pickAttr(attrs, "cloudflare.response.time_to_first_byte_ms")
		const rayId = pickAttr(attrs, "cloudflare.ray_id")

		const fields: CloudPlatformField[] = []
		if (scriptName) fields.push({ label: "Script", value: scriptName })
		if (scriptVersion)
			fields.push({
				label: "Version",
				value: scriptVersion,
				display: scriptVersion.slice(0, 8),
				copyable: true,
			})
		if (model) fields.push({ label: "Model", value: model })
		if (handler) fields.push({ label: "Handler", value: handler })
		if (cpu) fields.push({ label: "CPU / Wall", value: wall ? `${cpu}ms / ${wall}ms` : `${cpu}ms` })
		if (ttfb) fields.push({ label: "TTFB", value: `${ttfb}ms` })
		if (rayId) fields.push({ label: "Ray ID", value: rayId, copyable: true, wide: true })

		return {
			id: "cloudflare",
			label: "Cloudflare Worker",
			kind: "Worker",
			Icon: CloudflareIcon,
			accentClassName: "text-[#F38020]",
			edge: joinEdge(pickAttr(attrs, "cloudflare.colo"), pickAttr(attrs, "faas.invoked_region")),
			location: [city, country].filter(Boolean).join(", ") || null,
			outcome: outcome ? { value: outcome, bad: outcome.toLowerCase() !== "ok" } : null,
			fields,
		}
	},
}
