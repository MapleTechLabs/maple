import { CloudflareIcon } from "@/components/icons"
import { IntegrationNotConnected } from "../primitives/integration-not-connected"

interface CloudflareNotConnectedProps {
	/**
	 * `not-connected`: no Cloudflare OAuth connection at all.
	 * `needs-permissions`: connected, but the grant predates the analytics
	 * scopes — reconnecting re-consents with the full scope set.
	 */
	variant: "not-connected" | "needs-permissions"
}

export function CloudflareNotConnected({ variant }: CloudflareNotConnectedProps) {
	const fresh = variant === "not-connected"
	return (
		<IntegrationNotConnected
			icon={<CloudflareIcon size={16} />}
			title={fresh ? "Connect Cloudflare to see edge analytics" : "Update Cloudflare permissions"}
			description={
				fresh
					? "Connect your Cloudflare account and Maple will continuously ingest zone HTTP analytics and Workers invocation metrics. No agents or Logpush setup required."
					: "Your Cloudflare connection is missing the analytics read scopes. Reconnect to grant them and analytics polling will start automatically."
			}
			integration="cloudflare"
			actionLabel={fresh ? "Connect Cloudflare" : "Reconnect Cloudflare"}
			docsPage="cloudflare"
		/>
	)
}
