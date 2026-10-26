import { decideDashboardRename, evolveDashboardRename, RenameDashboard } from "@maple/domain/dashboard-domain"
import { DashboardDocument } from "@maple/domain/http"

/** Fold semantic rename events into the document loaded by the existing org-scoped CAS writer. */
export const renameDashboardDocument = (document: DashboardDocument, name: string): DashboardDocument => {
	const events = decideDashboardRename(document.name, new RenameDashboard({ name }))
	return events.length === 0
		? document
		: new DashboardDocument({
				...document,
				name: events.reduce(evolveDashboardRename, document.name),
			})
}
