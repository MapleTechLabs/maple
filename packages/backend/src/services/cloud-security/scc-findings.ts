// BOUNDARY-FILE: This module owns unparsed external values and narrows them before domain use.
/**
 * Security Command Center findings in the stored shape. Shared by the GCP poller (`findings.list`
 * results) and the notification receiver (Pub/Sub messages), so it makes no call of its own.
 * Both carry the same pair: the finding, and the resource it is about.
 */
import type { CloudFindingSeverity, CloudFindingStatus } from "@maple/domain/cloud-security"
import { GcpLocation, GcpProjectId, GcpResourceNumber } from "@maple/primitives"
import { Array as Arr, Option, Schema, String as Str } from "effect"
import { type FindingRead, msOf, readFinding } from "./finding-read"

const OptionalString = Schema.optionalKey(Schema.String)

/** The fields Maple reads; the rest of Google's record is kept in `detail`. */
export const SccFinding = Schema.Struct({
	name: Schema.String,
	category: OptionalString,
	description: OptionalString,
	resourceName: OptionalString,
	state: OptionalString,
	severity: OptionalString,
	mute: OptionalString,
	findingClass: OptionalString,
	eventTime: OptionalString,
	createTime: OptionalString,
	muteUpdateTime: OptionalString,
	externalUri: OptionalString,
})
export type SccFinding = typeof SccFinding.Type

export const SccResource = Schema.Struct({
	name: OptionalString,
	displayName: OptionalString,
	type: OptionalString,
	location: OptionalString,
	gcpMetadata: Schema.optionalKey(
		Schema.Struct({
			project: OptionalString,
			projectDisplayName: OptionalString,
			organization: OptionalString,
		}),
	),
})
export type SccResource = typeof SccResource.Type

/** One `findings.list` result, and the body of a notification pushed without Pub/Sub's wrapper. */
export const SccFindingResult = Schema.Struct({
	finding: SccFinding,
	resource: Schema.optionalKey(SccResource),
})
export type SccFindingResult = typeof SccFindingResult.Type

const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
const decodeResult = Schema.decodeUnknownOption(SccFindingResult)
export const decodeSccFindingResult = (value: unknown): Option.Option<SccFindingResult> => decodeResult(value)

export const sccSeverity = (severity: string | undefined): CloudFindingSeverity => {
	switch (severity) {
		case "CRITICAL":
			return "critical"
		case "HIGH":
			return "high"
		case "MEDIUM":
			return "medium"
		case "LOW":
			return "low"
		default:
			return "info"
	}
}

/** Muted is suppressed by the customer; inactive is closed by the service. */
export const sccStatus = (finding: Pick<SccFinding, "state" | "mute">): CloudFindingStatus =>
	finding.state === "INACTIVE" ? "resolved" : finding.mute === "MUTED" ? "archived" : "active"

/** `PUBLIC_BUCKET_ACL` reads as "Public bucket ACL": SCC's categories are its only titles. */
export const sccTitle = (category: string): string => {
	// Event Threat Detection names its categories for people already: "Persistence: IAM Anomalous Grant".
	if (!/^[A-Z0-9_]+$/u.test(category)) return category
	const words = Arr.filter(Str.split("_")(category), (word) => word !== "")
	return Arr.join(
		Arr.map(words, (word, index) => {
			// Acronyms SCC spells in categories stay upper case.
			if (/^(ACL|API|IAM|SSL|TLS|SQL|VM|IP|DNS|KMS|MFA|OS|RDP|SSH|GKE|CVE|XSS|HTTP|HTTPS)$/u.test(word))
				return word
			const lower = Str.toLowerCase(word)
			return index === 0 ? Str.capitalize(lower) : lower
		}),
		" ",
	)
}

const isProjectId = Schema.is(GcpProjectId)
const isResourceNumber = Schema.is(GcpResourceNumber)
const decodeLocation = Schema.decodeUnknownOption(GcpLocation)
const GLOBAL = Schema.decodeSync(GcpLocation)("global")

/** The last path segment of a resource name like `//cloudresourcemanager.googleapis.com/organizations/123`. */
const lastSegment = (name: string | undefined): string | undefined =>
	name === undefined ? undefined : Arr.last(Str.split("/")(name)).pipe(Option.getOrUndefined)

/**
 * The account a finding is in: the project's id where the resource is in one, else the
 * organization's number, else the connector's own scope.
 */
export const sccAccount = (
	result: SccFindingResult,
	fallback: GcpProjectId | GcpResourceNumber,
): GcpProjectId | GcpResourceNumber => {
	const metadata = result.resource?.gcpMetadata
	const project = metadata?.projectDisplayName
	if (project !== undefined && isProjectId(project)) return project
	const organization = lastSegment(metadata?.organization)
	if (organization !== undefined && isResourceNumber(organization)) return organization
	return fallback
}

/** Where SCC keeps it: the location segment of the finding's name, `global` when it names none. */
export const sccLocation = (findingName: string): GcpLocation => {
	const match = /\/locations\/([^/]+)\/findings\//u.exec(findingName)
	return match?.[1] === undefined ? GLOBAL : Option.getOrElse(decodeLocation(match[1]), () => GLOBAL)
}

export interface SccRead {
	readonly accountId: GcpProjectId | GcpResourceNumber
	readonly region: GcpLocation
	readonly finding: FindingRead
}

/**
 * One SCC finding in the stored shape. None when it has no time at all or a name too long to
 * keep. A finding's latest change is the later of its event and its mute; SCC moves `eventTime`
 * when a finding is seen again or closed.
 */
export const readSccFinding = (
	raw: unknown,
	fallbackAccount: GcpProjectId | GcpResourceNumber,
	nowMs: number,
): Option.Option<SccRead> =>
	Option.flatMap(decodeResult(raw), (result) => {
		const { finding, resource } = result
		const category = finding.category ?? "UNKNOWN"
		const eventAt = msOf(finding.eventTime)
		const mutedAt = msOf(finding.muteUpdateTime)
		const updatedAt =
			eventAt === undefined ? mutedAt : mutedAt === undefined ? eventAt : Math.max(eventAt, mutedAt)
		const detail = Option.getOrElse(decodeRecord(raw), () => ({}))
		return Option.map(
			readFinding(
				{
					findingId: finding.name,
					type:
						finding.findingClass === undefined ? category : `${finding.findingClass}/${category}`,
					title: sccTitle(category),
					description: finding.description,
					severity: sccSeverity(finding.severity),
					status: sccStatus(finding),
					resourceType: resource?.type,
					resourceId: finding.resourceName ?? resource?.name,
					resourceName: resource?.displayName,
					occurrences: undefined,
					firstSeenAt: msOf(finding.createTime),
					lastSeenAt: eventAt,
					updatedAt,
					detail,
				},
				nowMs,
			),
			(read): SccRead => ({
				accountId: sccAccount(result, fallbackAccount),
				region: sccLocation(finding.name),
				finding: read,
			}),
		)
	})
