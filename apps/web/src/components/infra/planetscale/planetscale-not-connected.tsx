import { PlanetScaleIcon } from "@/components/icons"
import { IntegrationNotConnected } from "../primitives/integration-not-connected"

export function PlanetScaleNotConnected() {
	return (
		<IntegrationNotConnected
			icon={<PlanetScaleIcon size={16} />}
			title="Connect PlanetScale to see database health"
			description="Authorize your PlanetScale organization with one click and Maple tracks every branch's health (connections, CPU, memory, replication lag) with nothing to install."
			integration="planetscale"
			actionLabel="Connect PlanetScale"
			docsPage="planetscale"
		/>
	)
}
