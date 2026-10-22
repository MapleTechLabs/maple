import type { GcpScopeType } from "@maple/domain/primitives"
import type { GcpCollectLock, GcpDraftEffect } from "../../components/integrations/gcp-connector-state"
import { docsUrl } from "../../lib/docs"
import type { Capability } from "./gcp-configure-schema"

// `GcpConfigure`'s copy.

export const DOCS = docsUrl("gcp")
export const OTEL_DOCS = docsUrl("gcpOpenTelemetry")
export const MANUAL_DOCS = docsUrl("gcpManualSetup")
export const IAC_DOCS = docsUrl("gcpInfrastructureAsCode")

export const PROJECT_ID_RULE =
	"A project ID is 6 to 30 lowercase letters, digits and hyphens. It starts with a letter and can't end with a hyphen. The project name and number don't work."

export const SCOPES = {
	project: {
		description: "One project.",
		idLabel: "Project ID",
		idRule: PROJECT_ID_RULE,
		placeholder: "acme-prod",
		hint: "The ID, not the name or number.",
		listCommand: "gcloud projects list",
	},
	folder: {
		description: "Every project in the folder, including new ones.",
		idLabel: "Folder ID",
		idRule: "A folder ID is digits only, such as 123456789012.",
		placeholder: "123456789012",
		hint: "Digits only, with your organization's ID in place of ORGANIZATION_ID.",
		listCommand: "gcloud resource-manager folders list --organization=ORGANIZATION_ID",
	},
	organization: {
		description: "Every project in the organization, including new ones.",
		idLabel: "Organization ID",
		idRule: "An organization ID is digits only, such as 123456789012.",
		placeholder: "123456789012",
		hint: "Digits only.",
		listCommand: "gcloud organizations list",
	},
} as const
export const SCOPE_TYPES: ReadonlyArray<GcpScopeType> = ["project", "folder", "organization"]

export const LOCK_NOTES = {
	"last-on": "A connection collects at least one of the two. To stop collecting, disconnect.",
	"metrics-unavailable": "Not available on this Maple deployment.",
} as const satisfies { readonly [Lock in GcpCollectLock]: string }

export const STEPS = ["Scope", "Data", "Method", "Set up"] as const

/** What an existing sink's filter can be left as or replaced with. */
export const FILTER_MODES = [
	{ value: "keep", label: "Keep current filter", hint: "Leaves the sink as it is" },
	{ value: "set", label: "Replace filter", hint: "Sets the filter below" },
] as const

export const CAPABILITY_IDS: ReadonlyArray<Capability> = ["logs", "metrics"]

type Acting = "stops-now" | "resumes-now"

export const CAPABILITIES = {
	logs: {
		title: "Log forwarding",
		flag: "logs_enabled",
		description: "Request, audit and managed-service logs, through a Log Router sink and Pub/Sub.",
		run: { on: "Log sink and Pub/Sub topic", off: "Removes the log sink" },
		effects: {
			"starts-after-script": "Starts once it's set up in Google Cloud",
			"resumes-now": "Stored again as soon as you save",
			"stops-now": "Maple stops storing them when you save",
			"removed-by-script": "Still forwarded by Google Cloud until the change is applied there",
		},
		now: {
			"stops-now": "Stops storing this connection's logs within about a minute.",
			"resumes-now": "Stores this connection's logs again, at once.",
		},
		later: {
			"stops-now":
				"Keeps forwarding them to Pub/Sub, billed by Google, until the change is applied in Google Cloud.",
			"resumes-now": "Nothing to apply: the log sink is still there and forwarding.",
		},
	},
	metrics: {
		title: "Metrics and resources",
		flag: "metrics_enabled",
		description:
			"Cloud Run, GKE, Compute Engine, Cloud SQL, Pub/Sub, Load Balancing and Cloud Functions. Read-only, every 5 minutes.",
		run: { on: "Read-only service account", off: "Removes the service account" },
		effects: {
			"starts-after-script": "Starts once it's set up in Google Cloud",
			"resumes-now": "Read again from the next 5-minute read",
			"stops-now": "Maple stops reading when you save",
			"removed-by-script":
				"Its service account stays in Google Cloud until the change is applied there",
		},
		now: {
			"stops-now": "Stops reading this connection's metrics and resources from the next 5-minute read.",
			"resumes-now": "Reads this connection's metrics and resources again from the next 5-minute read.",
		},
		later: {
			"stops-now":
				"Keeps the read-only service account and its roles until the change is applied in Google Cloud.",
			"resumes-now": "Nothing to apply: the read-only service account is still there.",
		},
	},
} as const satisfies {
	readonly [Key in Capability]: {
		readonly title: string
		readonly flag: "logs_enabled" | "metrics_enabled"
		readonly description: string
		/** What the script sets up for it, or removes, in the run step's status. */
		readonly run: { readonly on: string; readonly off: string }
		readonly effects: { readonly [Effect in GcpDraftEffect]: string }
		/** What a choice that acts at once does when it is saved, and what stays until the script runs. */
		readonly now: { readonly [Effect in Acting]: string }
		readonly later: { readonly [Effect in Acting]: string }
	}
}
