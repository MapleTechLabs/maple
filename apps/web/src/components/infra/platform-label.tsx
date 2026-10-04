import { cn } from "@maple/ui/lib/utils"

import {
	AmazonIcon,
	AppleIcon,
	GoogleIcon,
	LinuxIcon,
	MicrochipIcon,
	MicrosoftIcon,
	type IconComponent,
} from "@/components/icons"

/** Which OTel resource attribute a value came from: `os.type`, `host.arch` or `cloud.provider`. */
export type PlatformKind = "os" | "arch" | "cloud"

interface Known {
	readonly icon?: IconComponent
	readonly label: string
}

const OS = new Map<string, Known>([
	["linux", { icon: LinuxIcon, label: "Linux" }],
	["darwin", { icon: AppleIcon, label: "macOS" }],
	["windows", { icon: MicrosoftIcon, label: "Windows" }],
])

const CLOUD = new Map<string, Known>([
	["aws", { icon: AmazonIcon, label: "AWS" }],
	["gcp", { icon: GoogleIcon, label: "GCP" }],
	["azure", { icon: MicrosoftIcon, label: "Azure" }],
])

function resolve(kind: PlatformKind, value: string): Known {
	const key = value.toLowerCase()
	if (kind === "arch") return { icon: MicrochipIcon, label: key }
	return (kind === "os" ? OS : CLOUD).get(key) ?? { label: value }
}

/** An OS, CPU architecture or cloud value with its mark. Unknown values keep their raw text. */
export function PlatformLabel({
	kind,
	value,
	className,
}: {
	kind: PlatformKind
	value: string
	className?: string
}) {
	const { icon: Icon, label } = resolve(kind, value)
	return (
		<span className={cn("inline-flex items-center gap-1", className)}>
			{Icon ? <Icon size={11} className="shrink-0 opacity-80" /> : null}
			{label}
		</span>
	)
}
