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
	/** Brand colour for the mark. Omitted for marks that are monochrome by design (Apple, the chip). */
	readonly color?: string
}

const OS = new Map<string, Known>([
	["linux", { icon: LinuxIcon, label: "Linux", color: "#FCC624" }],
	["darwin", { icon: AppleIcon, label: "macOS" }],
	["windows", { icon: MicrosoftIcon, label: "Windows", color: "#0078D4" }],
])

const CLOUD = new Map<string, Known>([
	["aws", { icon: AmazonIcon, label: "AWS", color: "#FF9900" }],
	["gcp", { icon: GoogleIcon, label: "GCP", color: "#4285F4" }],
	["azure", { icon: MicrosoftIcon, label: "Azure", color: "#0078D4" }],
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
	const { icon: Icon, label, color } = resolve(kind, value)
	return (
		<span className={cn("inline-flex items-center gap-1", className)}>
			{Icon ? (
				<Icon
					size={11}
					className={cn("shrink-0", color ? undefined : "text-foreground/70")}
					style={color ? { color } : undefined}
				/>
			) : null}
			{label}
		</span>
	)
}
