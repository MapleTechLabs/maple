import { CLOUDFLARE_ACCENT_CLASS, dbSystemAccentClass } from "@maple/ui/lib/cloud-platforms/accents"
import { getCloudPlatform, pickAttr } from "../../../../service-map/trace-flow/cloud-platforms"
import type { IconName } from "../../../../ui/icon"

// The `CloudPlatformInfo` fields a span row reads. The flow port's copy of the adapters gives
// label, icon, edge, location and outcome; the accents come from the shared @maple/ui module.

export interface RowPlatform {
	readonly id: string
	readonly label: string
	readonly icon: IconName
	readonly accentClassName: string
	readonly edge: string | null
	readonly location: string | null
	readonly outcome: { readonly value: string; readonly bad: boolean } | null
}

export const rowPlatform = (attrs: Record<string, string>): RowPlatform | null => {
	const platform = getCloudPlatform(attrs)
	if (platform === null) return null
	if (platform.id === "cloudflare") return { ...platform, accentClassName: CLOUDFLARE_ACCENT_CLASS }
	const system = (pickAttr(attrs, "db.system.name", "db.system") ?? "").toLowerCase()
	return {
		...platform,
		accentClassName: dbSystemAccentClass(system),
	}
}
