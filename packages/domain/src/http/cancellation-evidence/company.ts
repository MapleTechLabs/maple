import { Schema } from "effect"
import { MapleRegion } from "../../organization-regions"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * Who the customer likely is and how its people used Maple: business data from
 * Clerk, Stripe, the members' email domains and the top domain's homepage, and
 * member engagement as counts. Never an email, a person's name or a user id.
 * Each part is `null` when it could not be read.
 */
export const CancellationCompanyEvidence = Schema.Struct({
	/**
	 * The org's name as its members typed it in Maple; null when Clerk could not
	 * be read or is not used, or when it holds a member's name.
	 */
	orgName: Schema.NullOr(Schema.String),
	/** The org's name holds a member's name ("Jane's Org"), so it is left out. */
	orgNameIsPersonal: Schema.Boolean,
	/** The Maple region the org's data lives in. */
	region: MapleRegion,
	/** The Stripe customer billed for the plan; null when Stripe could not be read. */
	billing: Schema.NullOr(
		Schema.Struct({
			/** Whether the org has a Stripe customer; false means every field below is empty. */
			linked: Schema.Boolean,
			/** The name invoices are addressed to, usually the company's; null when it may be a member's name. */
			name: Schema.NullOr(Schema.String),
			/**
			 * The name was left out as possibly a member's: it holds a member's name,
			 * or member names could not all be read and it matches neither the org
			 * name nor a company domain. Likely an individual, not a company.
			 */
			nameIsPersonal: Schema.Boolean,
			/** Billing address country, ISO 3166-1 alpha-2. */
			country: Schema.NullOr(Schema.String),
			/** Billing address city. */
			city: Schema.NullOr(Schema.String),
			/** Tax IDs on the customer by type (Stripe's, e.g. `eu_vat`) and country; never the number. First 5. */
			taxIds: Schema.Array(
				Schema.Struct({ type: Schema.String, country: Schema.NullOr(Schema.String) }),
			),
		}),
	),
	/** The members' email domains now; null when the member list could not be read. */
	emailDomains: Schema.NullOr(
		Schema.Struct({
			/** Domains that are neither free mail nor throwaway, by members on each, most first. First 5. */
			company: Schema.Array(Schema.Struct({ domain: Schema.String, members: Count })),
			/** Members on a personal free-mail domain (gmail, outlook, proton, ...). */
			freeMailMembers: Count,
			/** Members on a throwaway or reserved test domain, a Clerk test address, or Maple staff. */
			testMembers: Count,
		}),
	),
	/**
	 * The public homepage of the top company domain, read at review time. Null
	 * when there is no company domain or the page could not be read in 2.5 s.
	 * Texts are capped at 200 characters.
	 */
	homepage: Schema.NullOr(
		Schema.Struct({
			/** The company domain whose homepage this is. */
			domain: Schema.String,
			/** The page's `<title>`; null when it holds a member's name (a personal site). */
			title: Schema.NullOr(Schema.String),
			/** Its meta description, else its `og:description`. */
			description: Schema.NullOr(Schema.String),
			/** Its `og:site_name`; null when it holds a member's name. */
			siteName: Schema.NullOr(Schema.String),
			/** The host it redirected to when that is another domain (not just `www.`), else null. */
			redirectedTo: Schema.NullOr(Schema.String),
		}),
	),
	/** The org's current members as counts; null when Clerk could not be read or is not used. */
	people: Schema.NullOr(
		Schema.Struct({
			/** Members of the org now. */
			members: Count,
			/** Of them, members with the admin role. */
			admins: Count,
			/** Members who joined within the 30 days before the cancellation. */
			joinedLast30Days: Count,
			/** Days from the earliest current member joining to the cancellation; null when none joined before it. */
			firstJoinedDaysBeforeCancel: Schema.NullOr(Schema.Int),
			/** Days from the latest member joining before the cancellation to it; null when none did. */
			latestJoinedDaysBeforeCancel: Schema.NullOr(Schema.Int),
			/**
			 * Members whose latest sign-in or activity in Maple up to the
			 * cancellation (plus an hour) is within the 14 days before it. A member
			 * seen only after the cancellation is not counted.
			 */
			activeLast14Days: Count,
			/** The same within 30 days. */
			activeLast30Days: Count,
			/**
			 * Days from the most recent sign-in or activity of any member up to the
			 * cancellation (plus an hour, so 0 at most) to it; null when none.
			 */
			lastActiveDaysBeforeCancel: Schema.NullOr(Schema.Int),
		}),
	),
})
export type CancellationCompanyEvidence = Schema.Schema.Type<typeof CancellationCompanyEvidence>
