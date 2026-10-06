import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardPage } from "@/components/layout/dashboard-page"
import { Tabs, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { ApiKeysSection } from "@/components/settings/api-keys-section"
import { IngestionSection } from "@/components/settings/ingestion-section"

const DeveloperTab = Schema.Literals(["ingestion", "api-keys"])
const isDeveloperTab = Schema.is(DeveloperTab)

const DeveloperSearch = Schema.Struct({
	tab: Schema.optional(DeveloperTab),
})

export const Route = createFileRoute("/developer")({
	component: DeveloperPage,
	validateSearch: Schema.toStandardSchemaV1(DeveloperSearch),
})

function DeveloperPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const tab = search.tab ?? "ingestion"

	return (
		<DashboardPage
			breadcrumbs={[{ label: "Developer" }]}
			tabs={
				<Tabs
					value={tab}
					onValueChange={(next) => {
						if (isDeveloperTab(next)) void navigate({ search: { tab: next } })
					}}
				>
					<TabsList variant="underline">
						<TabsTrigger value="ingestion">Ingestion</TabsTrigger>
						<TabsTrigger value="api-keys">API Keys</TabsTrigger>
					</TabsList>
				</Tabs>
			}
		>
			{tab === "ingestion" ? <IngestionSection /> : <ApiKeysSection />}
		</DashboardPage>
	)
}
