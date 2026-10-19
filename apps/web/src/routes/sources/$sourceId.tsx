import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Button } from "@maple/ui/components/ui/button"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Option, Schema } from "effect"
import { useState } from "react"
import { ErrorState } from "@/components/common/error-state"
import { ResourceNotFound } from "@/components/common/resource-not-found"
import { DashboardPage } from "@/components/layout/dashboard-page"
import { fromPublicSourceId, type RevealedToken, useSource } from "@/components/sources/shared"
import {
	RolledTokenBanner,
	SourceHeader,
	SourceSetupTab,
	SourceTabs,
} from "@/components/sources/source-detail"
import { SourceOverview } from "@/components/sources/source-overview"
import { SOURCE_TABS } from "@/components/sources/source-tabs"
import { SourceSettings } from "@/components/sources/source-settings"
import type { SourceId } from "@maple/domain/primitives"

const SourceDetailSearch = Schema.Struct({
	tab: Schema.optional(Schema.Literals(SOURCE_TABS)),
})

export const Route = createFileRoute("/sources/$sourceId")({
	component: SourceDetailPage,
	validateSearch: Schema.toStandardSchemaV1(SourceDetailSearch),
})

function SourceDetailPage() {
	const { sourceId } = Route.useParams()
	const sourceIdOption = fromPublicSourceId(sourceId)
	return Option.isSome(sourceIdOption) ? (
		<SourceDetail sourceId={sourceIdOption.value} />
	) : (
		<DashboardPage breadcrumbs={[{ label: "Sources", href: "/sources" }, { label: "Not found" }]}>
			<NotFound />
		</DashboardPage>
	)
}

function NotFound() {
	return (
		<ResourceNotFound
			title="Source not found"
			description="It may have been deleted, or the link is wrong."
			backLink={<Button variant="outline" size="sm" render={<Link to="/sources" />} />}
			backLabel="Back to sources"
		/>
	)
}

function SourceDetail({ sourceId }: { sourceId: SourceId }) {
	const { tab = "overview" } = Route.useSearch()
	const navigate = useNavigate()
	const lookup = useSource(sourceId)
	// A rolled token lives only in memory, for as long as this page is open.
	const [revealed, setRevealed] = useState<RevealedToken | null>(null)

	if (lookup._tag !== "found") {
		return (
			<DashboardPage breadcrumbs={[{ label: "Sources", href: "/sources" }, { label: "Source" }]}>
				{lookup._tag === "loading" ? (
					<div className="flex flex-col gap-3">
						<Skeleton className="h-10 w-72" />
						<Skeleton className="h-40 w-full" />
					</div>
				) : lookup._tag === "failed" ? (
					<ErrorState error={lookup.cause} title="Couldn't load this source" />
				) : (
					<NotFound />
				)}
			</DashboardPage>
		)
	}
	const { source } = lookup
	const shownToken = revealed !== null && revealed.sourceId === source.id ? revealed : null

	return (
		<DashboardPage
			breadcrumbs={[{ label: "Sources", href: "/sources" }, { label: source.name }]}
			header={
				<SourceHeader
					source={source}
					onRevealed={setRevealed}
					onDeleted={() => navigate({ to: "/sources" })}
				/>
			}
			tabs={<SourceTabs source={source} active={tab} />}
			gap="md"
		>
			{shownToken !== null && shownToken.rolled && <RolledTokenBanner revealed={shownToken} />}
			{tab === "overview" && <SourceOverview source={source} />}
			{tab === "setup" && <SourceSetupTab source={source} revealed={shownToken} />}
			{tab === "settings" && <SourceSettings key={source.updated_at} source={source} />}
		</DashboardPage>
	)
}
