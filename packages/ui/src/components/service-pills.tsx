import { ServiceDot } from "./service-dot"
import { Badge } from "./ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip"

/** Pills drawn before the rest collapse into "+k". */
const VISIBLE_SERVICES = 3

/**
 * A row's services as coloured pills: the first few, then "+k" for the rest.
 * Shared by web's traces and agent-sessions tables and the local traces list, so a
 * service reads the same everywhere. The tooltip names every service, which is
 * exactly what a truncated pill and the "+k" leave out.
 */
export function ServicePills({ services }: { services: ReadonlyArray<string> }) {
	if (services.length === 0) return null
	return (
		<Tooltip>
			<TooltipTrigger render={<div />} className="flex min-w-0 flex-wrap gap-1">
				{services.slice(0, VISIBLE_SERVICES).map((service) => (
					<Badge key={service} variant="outline" className="max-w-full font-mono text-3xs">
						<ServiceDot serviceName={service} size="sm" />
						<span className="truncate">{service}</span>
					</Badge>
				))}
				{services.length > VISIBLE_SERVICES && (
					<Badge variant="outline" className="text-3xs">
						+{services.length - VISIBLE_SERVICES}
					</Badge>
				)}
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex flex-col gap-0.5 font-mono">
					{services.map((service) => (
						<span key={service}>{service}</span>
					))}
				</div>
			</TooltipContent>
		</Tooltip>
	)
}
