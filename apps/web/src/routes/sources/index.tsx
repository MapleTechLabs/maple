import { Button } from "@maple/ui/components/ui/button"
import { createFileRoute, Link } from "@tanstack/react-router"
import { PlusIcon } from "@/components/icons"
import { DashboardPage } from "@/components/layout/dashboard-page"
import { SourcesTable } from "@/components/sources/sources-table"

export const Route = createFileRoute("/sources/")({
	component: SourcesPage,
})

function SourcesPage() {
	return (
		<DashboardPage
			breadcrumbs={[{ label: "Sources" }]}
			headerActions={
				<Button size="sm" render={<Link to="/sources/new" />}>
					<PlusIcon data-icon="inline-start" />
					Connect source
				</Button>
			}
		>
			<SourcesTable />
		</DashboardPage>
	)
}
