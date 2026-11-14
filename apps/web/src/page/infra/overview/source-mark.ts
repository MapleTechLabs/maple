import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "@maple/views/ui/icon"
import type { IconName } from "@maple/views/ui/icons.generated"
import { PROVIDERS } from "../../kit/providers"
import type { SourceId } from "./model"

// The sources' titles and marks, as the sidebar draws them.

export const SOURCE_TITLE = {
	hosts: "Hosts",
	containers: "Containers",
	kubernetes: "Kubernetes",
	cloudflare: PROVIDERS.cloudflare.name,
	railway: PROVIDERS.railway.name,
	vercel: PROVIDERS.vercel.name,
	supabase: PROVIDERS.supabase.name,
	planetscale: PROVIDERS.planetscale.name,
	gcp: PROVIDERS.gcp.name,
	aws: PROVIDERS.aws.name,
} satisfies Record<SourceId, string>

export const SOURCE_ICON = {
	hosts: "ServerIcon",
	containers: "DockerIcon",
	kubernetes: "KubernetesIcon",
	cloudflare: PROVIDERS.cloudflare.icon,
	railway: PROVIDERS.railway.icon,
	vercel: PROVIDERS.vercel.icon,
	supabase: PROVIDERS.supabase.icon,
	planetscale: PROVIDERS.planetscale.icon,
	gcp: PROVIDERS.gcp.icon,
	aws: PROVIDERS.aws.icon,
} satisfies Record<SourceId, IconName>

export const sourceMark = <M>(h: HtmlBuilder<M>, id: SourceId, size: number, className?: string): Html =>
	icon(h, SOURCE_ICON[id], { size, className: cn("shrink-0 text-foreground", className) })
