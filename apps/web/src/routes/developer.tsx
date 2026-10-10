import { Link, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardPage } from "@/components/layout/dashboard-page"
import { UnderlineTabStrip, underlineTabClass } from "@/components/common/underline-link-tabs"
import { ApiKeysSection } from "@/components/settings/api-keys-section"
import { IngestionSection } from "@/components/settings/ingestion-section"

const DeveloperTab = Schema.Literals(["ingestion", "api-keys"])

const DeveloperSearch = Schema.Struct({
	tab: Schema.optional(DeveloperTab),
})

export const Route = createFileRoute("/developer")({
	component: DeveloperPage,
	validateSearch: Schema.toStandardSchemaV1(DeveloperSearch),
})

const DEVELOPER_TABS = [
	{ value: "ingestion", label: "Ingestion" },
	{ value: "api-keys", label: "API keys" },
] as const

function DeveloperPage() {
	const search = Route.useSearch()
	const tab = search.tab ?? "ingestion"

	return (
		<DashboardPage
			breadcrumbs={[{ label: "Developer" }]}
			tabs={
				<UnderlineTabStrip navigation label="Developer sections">
					{DEVELOPER_TABS.map((item) => (
						<Link
							key={item.value}
							to="/developer"
							search={{ tab: item.value }}
							aria-current={item.value === tab ? "page" : undefined}
							className={underlineTabClass(item.value === tab)}
						>
							{item.label}
						</Link>
					))}
				</UnderlineTabStrip>
			}
		>
			{tab === "ingestion" ? <IngestionSection /> : <ApiKeysSection />}
		</DashboardPage>
	)
}
