import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../../ui/icon"
import type { IconName } from "../../../ui/icons.generated"
import type { SourceId } from "./model"

// `SOURCE_TITLE` and `SourceMark`: the sidebar's marks.

export const SOURCE_TITLE = {
	hosts: "Hosts",
	containers: "Containers",
	kubernetes: "Kubernetes",
	cloudflare: "Cloudflare",
	railway: "Railway",
	supabase: "Supabase",
	planetscale: "PlanetScale",
	gcp: "Google Cloud",
	aws: "AWS",
} satisfies Record<SourceId, string>

const SOURCE_ICON = {
	hosts: "ServerIcon",
	containers: "DockerIcon",
	kubernetes: "KubernetesIcon",
	cloudflare: "CloudflareBrandIcon",
	railway: "RailwayIcon",
	supabase: "SupabaseIcon",
	planetscale: "PlanetScaleIcon",
	gcp: "GoogleCloudIcon",
	aws: "AwsIcon",
} satisfies Record<SourceId, IconName>

export const sourceMark = <M>(h: HtmlBuilder<M>, id: SourceId, size: number, className?: string): Html =>
	icon(h, SOURCE_ICON[id], { size, className: cn("shrink-0 text-foreground", className) })
