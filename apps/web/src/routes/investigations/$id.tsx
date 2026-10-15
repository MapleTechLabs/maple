import { ResourceNotFound } from "@/components/common/resource-not-found"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Option, Schema } from "effect"

import { INVESTIGATION_TABS } from "@/components/investigations/investigation-tabs"
import { ProvenanceCanvasLoading } from "@/components/investigations/flow/provenance-loading"
import { InvestigationView } from "@/components/investigations/investigation-view"
import { ErrorState } from "@/components/common/error-state"
import { DashboardPage } from "@/components/layout/dashboard-page"
import { DetailHeaderSkeleton } from "@/components/common/detail-header"
import { useInvestigation } from "@/hooks/use-investigation"
import { retryOrgCollections } from "@/lib/collections/org-collections"
import { InvestigationId } from "@maple/domain/http"

const SearchSchema = Schema.Struct({
	/**
	 * The open tab. Absent means Overview, so the canonical URL for an
	 * investigation stays clean and a link to Evidence survives a reload.
	 */
	tab: Schema.optional(Schema.Literals(INVESTIGATION_TABS)),
	/**
	 * The open proposed-action detail, by index into the report's actions, so the
	 * panel is linkable and survives a reload.
	 *
	 * Written as a number by `navigate`, which the router serialises as JSON — so
	 * the address bar reads `?action=1`. Typing it as `Schema.String` instead put
	 * `?action=%221%22` in the URL, which round-trips but is not a link anyone
	 * would write by hand.
	 *
	 * `Unknown` rather than `Number` because `validateSearch` is a throwing
	 * boundary: `?action=abc` against a number schema takes down the whole route
	 * behind an error boundary, and a mangled query string should cost the panel,
	 * not the investigation. The view narrows it.
	 */
	action: Schema.optional(Schema.Unknown),
})

export const Route = createFileRoute("/investigations/$id")({
	component: InvestigationPage,
	validateSearch: Schema.toStandardSchemaV1(SearchSchema),
})

const decodeInvestigationId = Schema.decodeUnknownOption(InvestigationId)

function InvestigationPage() {
	const { id: rawId } = Route.useParams()
	const { tab, action } = Route.useSearch()
	// A malformed branded UUID is a normal not-found result, not a route error.
	const decoded = decodeInvestigationId(rawId)
	if (Option.isNone(decoded)) return <NotFoundShell />
	return <InvestigationDetail action={action} id={decoded.value} tab={tab} />
}

/**
 * The page's data is an ElectricSQL shape, not a fetch.
 *
 * It used to poll `/v2/investigations/:id` every 3s while a run was in flight,
 * which put a three-second floor under every transition the provenance canvas
 * draws — a lane going `checking`, a progress note, the verdict landing. The two
 * shapes (`investigations` + its lens lanes) are recombined into the same
 * `V2Investigation` this view already took, so nothing below here changed.
 */
function InvestigationDetail({
	action,
	id,
	tab,
}: {
	action: unknown
	id: InvestigationId
	tab: (typeof INVESTIGATION_TABS)[number] | undefined
}) {
	const sync = useInvestigation(id)

	switch (sync.state) {
		case "loading":
			return <LoadingShell />
		// The shape synced and this org has no such row. Unlike a dropped request,
		// this IS a dead end — the sync is authoritative about what the org holds.
		case "missing":
			return <NotFoundShell />
		// The stream gave up (or never loaded) — a transport problem, not a missing
		// investigation. Telling someone their investigation is gone when it isn't
		// sends them looking for a problem that doesn't exist, so this stays a retry.
		case "failed":
			return (
				<LoadFailureShell
					error={new Error("The live connection to this investigation was lost")}
					onRetry={retryOrgCollections}
				/>
			)
		case "ready":
			return (
				<InvestigationView
					action={action}
					investigation={sync.investigation}
					tab={tab ?? "overview"}
				/>
			)
	}
}

const INVESTIGATIONS_CRUMB = { label: "Investigations", href: "/investigations" }

function LoadFailureShell({ error, onRetry }: { error: unknown; onRetry: () => void }) {
	return (
		<DashboardPage breadcrumbs={[INVESTIGATIONS_CRUMB, { label: "Error" }]}>
			<ErrorState error={error} title="This investigation could not be loaded" onRetry={onRetry} />
		</DashboardPage>
	)
}

/**
 * The header rows are bars, but the canvas is not: it is the page's lead widget,
 * and a grey block standing in for it told the reader nothing about what was
 * coming. The ghost draws the chain it is about to be replaced by.
 */
function LoadingShell() {
	return (
		<DashboardPage
			breadcrumbs={[INVESTIGATIONS_CRUMB, { label: "Loading…" }]}
			header={<DetailHeaderSkeleton />}
		>
			<ProvenanceCanvasLoading />
		</DashboardPage>
	)
}

function NotFoundShell() {
	return (
		<DashboardPage breadcrumbs={[INVESTIGATIONS_CRUMB, { label: "Not found" }]}>
			<ResourceNotFound
				title="This investigation is unavailable"
				description="It may have been removed, or it belongs to a different organization."
				backLink={<Link to="/investigations" />}
				backLabel="View investigations"
			/>
		</DashboardPage>
	)
}
