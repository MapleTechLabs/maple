/**
 * DNS validation for ACM certificates whose zone is on Cloudflare. alchemy's
 * `AWS.ACM.Certificate` only auto-validates via a Route53 `hostedZoneId`.
 *
 * Chain: `AcmValidationRecord` (read the CNAME ACM wants), `Cloudflare.DNS.Record`
 * (publish it), `AcmCertificateIssued` (wait for ISSUED; consumes the record's
 * name so it runs after it). Both are read-only against AWS.
 *
 * Resources, not `Output.mapEffect`: an `EffectExpr` resolves during `alchemy
 * plan`, which would then block in the ISSUED wait. `reconcile` runs at apply only.
 */
import * as acm from "@distilled.cloud/aws/acm"
import * as AwsRegion from "@distilled.cloud/aws/Region"
import { adopt } from "alchemy/AdoptPolicy"
import * as Cloudflare from "alchemy/Cloudflare"
import type { Input } from "alchemy/Input"
import * as Output from "alchemy/Output"
import * as Provider from "alchemy/Provider"
import { Resource } from "alchemy/Resource"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { requiredPlain } from "../env.ts"
import type { AwsRegionName } from "./stage.ts"

/** ACM fills `ResourceRecord` in asynchronously; matches alchemy's `waitForValidationRecords`. */
const RECORD_POLL = Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(60)])

/**
 * First issuance regularly takes minutes; matches alchemy's `waitForIssued`
 * (10 minutes). `Schedule.max` stops when any arm stops, so `recurs` bounds it.
 */
const ISSUED_POLL = Schedule.max([Schedule.fixed("10 seconds"), Schedule.recurs(60)])

/** Statuses that never issue: fail immediately rather than burn the wait window. */
const isTerminalFailure = (status: string | undefined): boolean =>
	status === "FAILED" || status === "VALIDATION_TIMED_OUT"

/** A certificate read knows the ARN, a zone lookup knows the hostname; hence both optional. */
export class AcmValidationError extends Schema.TaggedError<AcmValidationError>()(
	"Maple.ACM.ValidationError",
	{
		certificateArn: Schema.optionalKey(Schema.String),
		hostname: Schema.optionalKey(Schema.String),
		message: Schema.String,
	},
) {}

export interface AcmValidationRecordProps {
	/** The certificate to read. Accepts the `certificateArn` Output of an `AWS.ACM.Certificate`. */
	certificateArn: string
	/** The region the certificate was requested in. */
	region: AwsRegionName
}

export interface AcmValidationRecordAttributes {
	certificateArn: string
	/** Fully-qualified record name ACM wants, trailing dot stripped. */
	recordName: string
	/** The CNAME target. */
	recordValue: string
}

export type AcmValidationRecord = Resource<
	"Maple.ACM.ValidationRecord",
	AcmValidationRecordProps,
	AcmValidationRecordAttributes
>

export const AcmValidationRecord = Resource<AcmValidationRecord>("Maple.ACM.ValidationRecord")

export interface AcmCertificateIssuedProps {
	certificateArn: string
	/** The region the certificate was requested in. */
	region: AwsRegionName
	/**
	 * Never read: consuming it orders this resource after the published
	 * `Cloudflare.DNS.Record`, and puts the record name in the plan output.
	 */
	publishedRecordName: string
}

export interface AcmCertificateIssuedAttributes {
	certificateArn: string
	status: string
}

export type AcmCertificateIssued = Resource<
	"Maple.ACM.CertificateIssued",
	AcmCertificateIssuedProps,
	AcmCertificateIssuedAttributes
>

export const AcmCertificateIssued = Resource<AcmCertificateIssued>("Maple.ACM.CertificateIssued")

/** A certificate must be described in the region it was requested in (the ALB's region). */
const describe = (certificateArn: string, region: AwsRegionName) =>
	acm.describeCertificate({ CertificateArn: certificateArn }).pipe(
		Effect.map((response) => response.Certificate),
		// Per-call region override; `Region`'s service value is an `Effect<RegionName>`.
		Effect.provideService(AwsRegion.Region, Effect.succeed(region)),
	)

/** ACM returns validation record names fully qualified with a trailing dot; DNS APIs do not want it. */
const stripTrailingDot = (name: string): string => name.replace(/\.$/, "")

export const AcmValidationRecordProvider = () =>
	Provider.succeed(AcmValidationRecord, {
		// Nothing to delete; without the skip, nuke loops on "deleted but still there".
		nuke: { skip: true },
		// No `stables`: `certificateArn` changes when the certificate is replaced, and
		// a stable's OLD value would plan the ALB listener against the deleted cert.
		list: () => Effect.succeed([]),
		delete: () => Effect.void,
		reconcile: Effect.fn(function* ({ news }) {
			const found = yield* describe(news.certificateArn, news.region).pipe(
				Effect.flatMap((detail) => {
					const options = detail?.DomainValidationOptions ?? []
					const records = options.flatMap((option) =>
						option.ResourceRecord?.Name && option.ResourceRecord.Value
							? [{ name: option.ResourceRecord.Name, value: option.ResourceRecord.Value }]
							: [],
					)
					// Not yet published, retry.
					if (records.length === 0 || records.length < options.length) {
						return Effect.fail(
							new AcmValidationError({
								certificateArn: news.certificateArn,
								message: "ACM has not published a DNS validation record yet",
							}),
						)
					}
					// SANs often share one record. Distinct records are not modeled: publishing
					// only the first would stall short of ISSUED with no reason given.
					const distinct = new Map(records.map((record) => [record.name, record]))
					const [first] = [...distinct.values()]
					if (distinct.size > 1 || first === undefined) {
						// oxlint-disable-next-line maple/no-effect-die -- unsupported stack shape, see above
						return Effect.die(
							new AcmValidationError({
								certificateArn: news.certificateArn,
								message: `certificate needs ${distinct.size} distinct validation records (${[...distinct.keys()].join(", ")}); this resource publishes one`,
							}),
						)
					}
					return Effect.succeed(first)
				}),
				Effect.retry({
					while: (error) => error._tag === "Maple.ACM.ValidationError",
					schedule: RECORD_POLL,
				}),
			)
			return {
				certificateArn: news.certificateArn,
				recordName: stripTrailingDot(found.name),
				recordValue: found.value,
			} satisfies AcmValidationRecordAttributes
		}),
	})

export const AcmCertificateIssuedProvider = () =>
	Provider.succeed(AcmCertificateIssued, {
		nuke: { skip: true },
		// No `stables`, see `AcmValidationRecordProvider`.
		list: () => Effect.succeed([]),
		delete: () => Effect.void,
		reconcile: Effect.fn(function* ({ news }) {
			const status = yield* describe(news.certificateArn, news.region).pipe(
				Effect.flatMap((detail) => {
					if (detail?.Status === "ISSUED") return Effect.succeed(detail.Status)
					// Terminal: fail now with ACM's reason instead of retrying.
					if (isTerminalFailure(detail?.Status)) {
						// oxlint-disable-next-line maple/no-effect-die -- the certificate can never issue, see above
						return Effect.die(
							new AcmValidationError({
								certificateArn: news.certificateArn,
								message: `certificate issuance failed: ${detail?.Status}${detail?.FailureReason ? ` (${detail.FailureReason})` : ""}`,
							}),
						)
					}
					return Effect.fail(
						new AcmValidationError({
							certificateArn: news.certificateArn,
							message: `certificate is ${detail?.Status ?? "unknown"}, not ISSUED`,
						}),
					)
				}),
				Effect.retry({
					while: (error) => error._tag === "Maple.ACM.ValidationError",
					schedule: ISSUED_POLL,
				}),
			)
			return { certificateArn: news.certificateArn, status } satisfies AcmCertificateIssuedAttributes
		}),
	})

/** Merge alongside `AWS.providers()`, whose credentials and HTTP client these reads use. */
export const providers = () => Layer.mergeAll(AcmValidationRecordProvider(), AcmCertificateIssuedProvider())

/**
 * Resolve the Cloudflare zone by hostname (read, never managed). A missing zone
 * is a misconfigured stack, so it dies.
 */
const resolveCloudflareZoneId = Effect.fn(function* (hostname: string) {
	const accountId = yield* requiredPlain("CLOUDFLARE_ACCOUNT_ID")
	return yield* Cloudflare.Zone.resolveZoneId({ accountId, zone: undefined, hostname }).pipe(
		Effect.catch((cause: Error) =>
			// oxlint-disable-next-line maple/no-effect-die -- stack wiring invariant, see above
			Effect.die(
				new AcmValidationError({
					hostname,
					message: `no Cloudflare zone for ${hostname}: ${cause.message}`,
				}),
			),
		),
	)
})

/** `https://host[:port]/path` to `host`: a load balancer's URL as a CNAME target. */
export const urlHost = (url: string | undefined): string =>
	url !== undefined && URL.canParse(url) ? new URL(url).hostname : ""

/**
 * Proxied CNAME from `hostname` to the host part of `serviceUrl`. `adopt(true)`
 * because the records predate the stack and Cloudflare has no ownership marker.
 */
export const publishProxiedCname = Effect.fn(function* ({
	id,
	hostname,
	serviceUrl,
}: {
	/** Logical id of the record. */
	id: string
	/** The public name, e.g. `ingest.maple.dev`; also selects the zone. */
	hostname: string
	/** The load balancer's URL, scheme and all. */
	serviceUrl: Output.Output<string | undefined>
}) {
	const zoneId = yield* resolveCloudflareZoneId(hostname)
	return yield* Cloudflare.DNS.Record(id, {
		zoneId,
		type: "CNAME",
		name: hostname,
		content: Output.map(serviceUrl, urlHost),
		proxied: true,
	}).pipe(adopt(true))
})

/**
 * Publish the validation CNAME, wait for ISSUED, and return the ARN. Feed the
 * RESULT (not `certificate.certificateArn`) to the ALB listener so it waits for
 * issuance; a PENDING_VALIDATION cert fails the listener.
 */
export const issueCertificateViaCloudflare = Effect.fn(function* ({
	id,
	certificateArn,
	hostname,
	region,
}: {
	/** Logical id prefix for the three resources this creates. */
	id: string
	/** Accepts an `AWS.ACM.Certificate`'s `certificateArn` Output. */
	certificateArn: Input<string>
	/** The name on the certificate, e.g. `ingest.maple.dev`; also selects the zone. */
	hostname: string
	region: AwsRegionName
}) {
	const zoneId = yield* resolveCloudflareZoneId(hostname)

	const validation = yield* AcmValidationRecord(`${id}-validation`, {
		certificateArn,
		region,
	})

	// Never proxied: the proxy would hide the CNAME target from ACM's validator.
	const record = yield* Cloudflare.DNS.Record(`${id}-validation-record`, {
		zoneId,
		type: "CNAME",
		name: validation.recordName,
		content: validation.recordValue,
		proxied: false,
		ttl: 60,
	})

	const issued = yield* AcmCertificateIssued(`${id}-issued`, {
		certificateArn,
		region,
		publishedRecordName: record.name,
	})

	return issued.certificateArn
})
