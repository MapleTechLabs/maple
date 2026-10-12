import { IconButton } from "@maple/ui/components/ui/icon-button"
import { InputGroupAddon } from "@maple/ui/components/ui/input-group"
import { cn } from "@maple/ui/lib/utils"
import {
	BellIcon,
	ChartLineIcon,
	CircleWarningIcon,
	DockerIcon,
	FileIcon,
	GridSquareCirclePlusIcon,
	NetworkNodesIcon,
	PulseIcon,
	ServerIcon,
	XmarkIcon,
	type IconComponent,
} from "@/components/icons"
import { CONCEPT_ICON } from "@/components/icons/concept"
import { autoContextDisplay, autoContextLabel, type AutoContext } from "./auto-contexts"

/**
 * The chip wears the same icon the sidebar row for that page wears, so a glance
 * confirms what the chat is looking at without reading the label.
 */
const CONTEXT_ICONS = {
	alert_rule: BellIcon,
	container: DockerIcon,
	dashboard: GridSquareCirclePlusIcon,
	error_issue: CircleWarningIcon,
	error_type: CircleWarningIcon,
	host: ServerIcon,
	logs_explorer: FileIcon,
	metrics_explorer: ChartLineIcon,
	service: CONCEPT_ICON.service,
	service_map: NetworkNodesIcon,
	trace: PulseIcon,
	traces_explorer: PulseIcon,
} satisfies Record<AutoContext["kind"], IconComponent>

interface PageContextChipsProps {
	contexts: AutoContext[]
	onDismiss: (id: string) => void
}

/**
 * What the chat is already looking at, rendered as a tray inside the composer
 * rather than as badges floating above it: the context belongs to the message
 * being written, and a detached row read as unrelated page furniture.
 */
export function PageContextChips({ contexts, onDismiss }: PageContextChipsProps) {
	if (contexts.length === 0) return null
	return (
		<InputGroupAddon align="block-start" className="flex-wrap gap-1 border-b">
			{contexts.map((ctx) => {
				const { kind, subject } = autoContextDisplay(ctx)
				const Icon = CONTEXT_ICONS[ctx.kind]
				return (
					<span
						key={ctx.id}
						className={cn(
							"group/chip inline-flex h-6 max-w-64 min-w-0 items-center gap-1.5",
							"rounded-md border border-border/60 bg-muted/40 py-0 pr-0.5 pl-1.5",
							"font-normal text-xs transition-colors hover:bg-muted/70",
						)}
					>
						<Icon className="size-3.5 shrink-0 text-muted-foreground" />
						<span className="min-w-0 truncate">
							<span className="text-muted-foreground">{kind}</span>
							{subject ? <span className="ml-1 text-foreground">{subject}</span> : null}
						</span>
						<IconButton
							size="icon-2xs"
							label={`Remove ${autoContextLabel(ctx)}`}
							tooltip={false}
							onClick={() => onDismiss(ctx.id)}
							className="text-muted-foreground/70 hover:text-foreground"
						>
							<XmarkIcon />
						</IconButton>
					</span>
				)
			})}
		</InputGroupAddon>
	)
}
