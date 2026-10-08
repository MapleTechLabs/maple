import { createFileRoute } from "@tanstack/react-router"

import { DashboardPage } from "@/components/layout/dashboard-page"
import { McpSection } from "@/components/settings/mcp-section"

export const Route = createFileRoute("/mcp")({
	component: McpPage,
})

// Standalone page for the same MCP setup UI rendered by /settings?tab=mcp.
// Both render <McpSection /> so the endpoint, generated client configs, and the
// key-creation flow can't drift apart.
function McpPage() {
	return (
		<DashboardPage breadcrumbs={[{ label: "MCP" }]}>
			<McpSection />
		</DashboardPage>
	)
}
