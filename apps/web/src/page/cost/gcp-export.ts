import type { GcpCostConnector, GcpCostStatus } from "@maple/domain/http"
import type { GcpConnectorId } from "@maple/primitives"
import { Array as Arr, Option, String as Str } from "effect"

/** Where Google says how to turn on the Cloud Billing export to BigQuery. */
export const GCP_EXPORT_DOCS_HREF = "https://cloud.google.com/billing/docs/how-to/export-data-bigquery-setup"

/** What the grant commands name until a table id is typed. */
const TABLE_PLACEHOLDER = "BILLING_PROJECT:DATASET.TABLE"

// `project.dataset.table` or `project:dataset.table`, as BigQuery's console copies it.
const TABLE_ID = /^([a-z][a-z0-9-]{4,28}[a-z0-9])[.:]([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$/u

/** The typed table id as `bq` names a table (`project:dataset.table`), or None until it reads as one. */
export const bqTableOf = (draft: string): Option.Option<string> => {
	const match = TABLE_ID.exec(Str.trim(draft))
	return match === null ? Option.none() : Option.some(`${match[1]}:${match[2]}.${match[3]}`)
}

/**
 * The connection the export will be read through: the one picked, while it can still read, else
 * the first that can. None when no connection has a reader account (Metrics and resources off).
 */
export const gcpConnectorOf = (
	status: GcpCostStatus,
	picked: GcpConnectorId | null,
): Option.Option<GcpCostConnector> => {
	const readable = Arr.filter(status.connectors, (connector) => connector.metricsEnabled)
	return Option.orElse(
		Arr.findFirst(readable, (connector) => connector.id === picked),
		() => Arr.head(readable),
	)
}

/**
 * What the org runs once so the reader account can query the export: the BigQuery API on the host
 * project, where the query runs, Job User there, and Data Viewer on the export table alone.
 */
export const gcpGrantCommands = (connector: GcpCostConnector, draft: string): string => {
	const member = `serviceAccount:${connector.readerEmail}`
	const table = Option.getOrElse(bqTableOf(draft), () => TABLE_PLACEHOLDER)
	return Arr.join(
		[
			`gcloud services enable bigquery.googleapis.com --project=${connector.projectId}`,
			`gcloud projects add-iam-policy-binding ${connector.projectId} \\`,
			`  --member=${member} \\`,
			`  --role=roles/bigquery.jobUser --condition=None`,
			`bq add-iam-policy-binding --table=true \\`,
			`  --member=${member} \\`,
			`  --role=roles/bigquery.dataViewer \\`,
			`  ${table}`,
		],
		"\n",
	)
}
