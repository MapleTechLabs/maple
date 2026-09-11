import { ServiceDot } from "@maple/ui/components/service-dot"
import { Badge } from "@maple/ui/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"

/** Pills drawn before the rest collapse into "+k". */
const VISIBLE_SERVICES = 3

/**
 * A row's services as coloured pills — the first few, then "+k" for the rest.
 * Shared by the traces and agent-sessions tables so a service reads the same in
 * both. The tooltip names every service, which is exactly what a truncated pill
 * and the "+k" leave out.
 */
export function ServicePills({ services }: { services: ReadonlyArray<string> }) {
	if (services.length === 0) return null
	return (
		<Tooltip>
			<TooltipTrigger render={<div />} className="flex min-w-0 flex-wrap gap-1">
				{services.slice(0, VISIBLE_SERVICES).map((service) => (
					<Badge key={service} variant="outline" className="max-w-full font-mono text-[10px]">
						<ServiceDot serviceName={service} className="size-1.5" />
						<span className="truncate">{service}</span>
					</Badge>
				))}
				{services.length > VISIBLE_SERVICES && (
					<Badge variant="outline" className="text-[10px]">
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
