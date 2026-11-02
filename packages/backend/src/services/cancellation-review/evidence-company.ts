/**
 * The company evidence: who the customer likely is (Clerk's org name, the
 * Stripe customer, the members' email domains and the top domain's homepage)
 * and how many of its people were around. Counts and business data only,
 * never an address, a person's name or a user id.
 */
import type { BillingProfile, CancellationCompanyEvidence as Section } from "@maple/domain/http"
import { Cause, Context, Duration, Effect, Layer, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, type HttpClientError, HttpClientRequest } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { readBillingProfile } from "@maple/backend/services/billing/billing-profile"
import { StripeClient } from "@maple/backend/services/billing/stripe-http"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"
import { type MemberActivity, OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { type CancellationEvidenceInput, daysBeforeCancel, knownAtCancel, redactText } from "./evidence-input"
import {
	DISPOSABLE_DOMAINS,
	FREE_MAIL_DOMAINS,
	FREE_MAIL_PROVIDERS,
	MAPLE_DOMAINS,
	RESERVED_SUFFIXES,
	WILDCARD_DNS_DOMAINS,
} from "./free-mail-domains"

type Billing = NonNullable<Section["billing"]>
type EmailDomains = NonNullable<Section["emailDomains"]>
type Homepage = NonNullable<Section["homepage"]>
type People = NonNullable<Section["people"]>

export const COMPANY_DOMAINS_SHOWN = 5
export const TAX_IDS_SHOWN = 5
/** Each Clerk or Stripe read; the whole section is given about 8 s. */
const SUB_READ_TIMEOUT = Duration.seconds(4)
/** Company domains whose homepage is tried, one after another. */
const HOMEPAGE_DOMAINS_TRIED = 2
/** The whole homepage read, redirects included; it can wait for a free connection first. */
const HOMEPAGE_TIMEOUT = Duration.seconds(5)
const HOMEPAGE_MAX_BYTES = 200_000
/** What the tag search sees: the `<head>`, at most this much, so no pattern runs over a whole page. */
const HEAD_MAX_CHARS = 64_000
/** Where a page without a `</head>` is cut. */
const HEADLESS_MAX_CHARS = 16_000
const HOMEPAGE_MAX_REDIRECTS = 3
const TEXT_MAX = 200

/** The homepage was refused or answered with something other than a page. */
export class CancellationHomepageError extends Schema.TaggedError<CancellationHomepageError>()(
	"@maple/backend/cancellation-review/CancellationHomepageError",
	{ message: Schema.String },
) {}

/** One line through `redactText`, at most 200 characters; null when empty. */
const text = (value: string | null | undefined): string | null => {
	const cleaned = redactText((value ?? "").slice(0, 4 * TEXT_MAX).replaceAll(/\s+/g, " "), TEXT_MAX)
	return cleaned === "" ? null : cleaned
}

/** No Stripe customer is a read with nothing in it, not a failed one. */
export const billingOf = (profile: BillingProfile | null): Billing => ({
	linked: profile !== null,
	name: text(profile?.name),
	nameIsPersonal: false,
	country: profile?.address?.country?.toUpperCase() ?? null,
	city: text(profile?.address?.city),
	taxIds: (profile?.taxIds ?? [])
		.slice(0, TAX_IDS_SHOWN)
		.map((taxId) => ({ type: taxId.type, country: taxId.country ?? null })),
})

/** Whether `domain` is one of `domains` or a subdomain of one. */
const inDomains = (domains: ReadonlySet<string>, domain: string): boolean => {
	const labels = domain.split(".")
	return labels.some((_, index) => domains.has(labels.slice(index).join(".")))
}

const isReserved = (domain: string): boolean =>
	inDomains(DISPOSABLE_DOMAINS, domain) ||
	inDomains(MAPLE_DOMAINS, domain) ||
	inDomains(WILDCARD_DNS_DOMAINS, domain) ||
	RESERVED_SUFFIXES.some((suffix) => domain.endsWith(suffix)) ||
	domain.split(".").includes("clerk")

/** A listed free-mail domain or its subdomain, or a provider under any country ending (`yahoo.com.br`). */
export const isFreeMail = (domain: string): boolean => {
	const [provider = "", ...rest] = domain.split(".")
	return (
		inDomains(FREE_MAIL_DOMAINS, domain) ||
		(FREE_MAIL_PROVIDERS.has(provider) && /^[a-z]{2,3}(?:\.[a-z]{2})?$/.test(rest.join(".")))
	)
}

/**
 * Members counted by the domain of their address. Free-mail, test and Maple's
 * own domains are only counted, never named; a Clerk test address (`+clerk_test`) is a test
 * member whatever its domain.
 */
export const emailDomainsOf = (members: ReadonlyArray<{ readonly email: string }>): EmailDomains => {
	const company = new Map<string, number>()
	let freeMailMembers = 0
	let testMembers = 0
	for (const { email } of members) {
		const at = email.lastIndexOf("@")
		const domain = email
			.slice(at + 1)
			.trim()
			.toLowerCase()
		if (
			at < 0 ||
			!domain.includes(".") ||
			isReserved(domain) ||
			email.slice(0, at).includes("+clerk_test")
		) {
			testMembers++
		} else if (isFreeMail(domain)) {
			freeMailMembers++
		} else {
			company.set(domain, (company.get(domain) ?? 0) + 1)
		}
	}
	return {
		company: [...company]
			.sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
			.slice(0, COMPANY_DOMAINS_SHOWN)
			.map(([domain, count]) => ({ domain, members: count })),
		freeMailMembers,
		testMembers,
	}
}

/**
 * A public DNS name the homepage read may ask for: two labels at least, a
 * letter TLD (so no IP literal), and not a reserved or local name.
 */
export const isFetchableHost = (host: string): boolean =>
	host.length <= 253 &&
	/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(host) &&
	!isReserved(host)

const NAMED_ENTITIES = new Map(
	Object.entries({
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
		ndash: "–",
		mdash: "—",
		hellip: "…",
		lsquo: "‘",
		rsquo: "’",
		ldquo: "“",
		rdquo: "”",
		middot: "·",
		bull: "•",
		copy: "©",
		reg: "®",
		trade: "™",
	}),
)

const decodeEntities = (value: string): string =>
	value.replaceAll(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{1,32});/gi, (entity, name: string) => {
		const code =
			name.startsWith("#x") || name.startsWith("#X")
				? Number.parseInt(name.slice(2), 16)
				: name.startsWith("#")
					? Number.parseInt(name.slice(1), 10)
					: null
		if (code === null) return NAMED_ENTITIES.get(name.toLowerCase()) ?? entity
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
	})

const attributesOf = (tag: string): ReadonlyMap<string, string> =>
	new Map(
		[...tag.matchAll(/([^\s"'=<>/]{1,64})\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)].map((match) => [
			(match[1] ?? "").toLowerCase(),
			match[2] ?? match[3] ?? match[4] ?? "",
		]),
	)

/** `<meta name|property=… content=…>` by lowercased key, the first of each. */
const metaOf = (html: string): ReadonlyMap<string, string> => {
	const meta = new Map<string, string>()
	for (const [tag] of html.matchAll(/<meta\b[^>]{0,2000}>/gi)) {
		const attributes = attributesOf(tag)
		const key = (attributes.get("name") ?? attributes.get("property"))?.toLowerCase()
		const content = attributes.get("content")
		if (key !== undefined && content !== undefined && !meta.has(key)) meta.set(key, content)
	}
	return meta
}

const withoutWww = (host: string): string => host.replace(/^www\./, "")

/**
 * What a homepage says about its company. `finalHost` is where the redirects
 * ended. Only the `<head>` is searched and every pattern is bounded, so a
 * hostile page costs no more than a normal one.
 */
export const homepageOf = (domain: string, page: string, finalHost: string): Homepage => {
	const headEnd = page.search(/<\/head>/i)
	const html = page.slice(0, headEnd < 0 ? HEADLESS_MAX_CHARS : Math.min(headEnd, HEAD_MAX_CHARS))
	const meta = metaOf(html)
	const field = (value: string | undefined) =>
		text(value === undefined ? null : decodeEntities(value.slice(0, 4 * TEXT_MAX)))
	return {
		domain,
		title: field(/<title\b[^>]{0,500}>([^<]{0,2000})<\/title>/i.exec(html)?.[1]),
		description: field(meta.get("description")) ?? field(meta.get("og:description")),
		siteName: field(meta.get("og:site_name")),
		redirectedTo: withoutWww(finalHost) === withoutWww(domain) ? null : finalHost,
	}
}

/**
 * Joins and sign-ins up to the cancellation (plus the evidence grace): a member
 * seen only after it was not active before it, as far as this can tell.
 */
export const peopleOf = (atMs: number, members: ReadonlyArray<MemberActivity>): People => {
	const known = (ms: number | null): ReadonlyArray<number> =>
		ms !== null && knownAtCancel(atMs, ms) ? [Math.max(0, daysBeforeCancel(atMs, ms))] : []
	const joined = members.flatMap((member) => known(member.joinedAtMs))
	const lastSeen = members.flatMap((member) => {
		const seen = [...known(member.lastSignInAtMs), ...known(member.lastActiveAtMs)]
		return seen.length === 0 ? [] : [Math.min(...seen)]
	})
	return {
		members: members.length,
		admins: members.filter((member) => member.role === "org:admin").length,
		joinedLast30Days: joined.filter((days) => days < 30).length,
		firstJoinedDaysBeforeCancel: joined.length === 0 ? null : Math.max(...joined),
		latestJoinedDaysBeforeCancel: joined.length === 0 ? null : Math.min(...joined),
		activeLast14Days: lastSeen.filter((days) => days < 14).length,
		activeLast30Days: lastSeen.filter((days) => days < 30).length,
		lastActiveDaysBeforeCancel: lastSeen.length === 0 ? null : Math.min(...lastSeen),
	}
}

/** Words of three letters or more, lowercase. */
const wordsOf = (value: string): ReadonlyArray<string> =>
	value
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word.length >= 3)

/** Local parts that name a role, not a person. */
const ROLE_ADDRESSES: ReadonlySet<string> = new Set([
	"info",
	"admin",
	"hello",
	"contact",
	"team",
	"dev",
	"devops",
	"ops",
	"support",
	"billing",
	"sales",
	"office",
	"mail",
	"tech",
	"engineering",
	"accounts",
	"finance",
])

/**
 * Words that could be a member's name: their first and last names, and the
 * parts of each address's local part that are neither a role nor the domain.
 */
export const memberNameWords = (
	emails: ReadonlyArray<string>,
	names: ReadonlyArray<string | null>,
): ReadonlySet<string> => {
	const words = new Set(names.flatMap((name) => (name === null ? [] : wordsOf(name))))
	for (const email of emails) {
		const at = email.lastIndexOf("@")
		const domainWords = new Set(wordsOf(email.slice(at + 1)))
		for (const word of wordsOf(email.slice(0, Math.max(at, 0)))) {
			if (!ROLE_ADDRESSES.has(word) && !domainWords.has(word)) words.add(word)
		}
	}
	return words
}

const holdsName = (value: string, nameWords: ReadonlySet<string>): boolean =>
	wordsOf(value).some((word) => nameWords.has(word))

/** What is known of the members' names. */
export interface MemberNames {
	/** From `memberNameWords`. */
	readonly words: ReadonlySet<string>
	/** Every member's first and last name was read; otherwise `words` may miss a name. */
	readonly complete: boolean
}

/**
 * Leaves out names that may be a member's: an org name ("Jane's Org"), a Stripe
 * customer name (a card holder) and a homepage title or site name (a personal
 * site) holding a member's name. Without every member's name, the Stripe name
 * is kept only when it shares a word with the org name or a company domain.
 */
export const withoutPersonalNames = (
	found: Pick<Section, "orgName" | "billing" | "homepage">,
	names: MemberNames,
	companyDomains: ReadonlyArray<string>,
): Pick<Section, "orgName" | "orgNameIsPersonal" | "billing" | "homepage"> => {
	const { billing, homepage } = found
	const orgNameIsPersonal = found.orgName !== null && holdsName(found.orgName, names.words)
	const orgName = orgNameIsPersonal ? null : found.orgName
	const companyWords = new Set([
		...wordsOf(orgName ?? ""),
		...companyDomains.flatMap((domain) => wordsOf(domain.slice(0, domain.lastIndexOf(".")))),
	])
	const billingIsPersonal =
		billing?.name != null &&
		(holdsName(billing.name, names.words) || (!names.complete && !holdsName(billing.name, companyWords)))
	const keep = (value: string | null) => (value !== null && holdsName(value, names.words) ? null : value)
	return {
		orgName,
		orgNameIsPersonal,
		billing:
			billing !== null && billingIsPersonal
				? { ...billing, name: null, nameIsPersonal: true }
				: billing,
		homepage:
			homepage === null
				? null
				: { ...homepage, title: keep(homepage.title), siteName: keep(homepage.siteName) },
	}
}

/** One request; the body is read only from an HTML page and cancelled when the scope closes. */
type Hop = { readonly _tag: "Redirect"; readonly to: URL } | { readonly _tag: "Page"; readonly html: string }

/**
 * GET `https://<domain>/`, following at most 3 redirects itself so every hop is
 * held to the same https-and-public-host rule, and reading at most 200 KB.
 */
export const fetchHomepage = (client: HttpClient.HttpClient, domain: string) => {
	const scoped = HttpClient.withScope(client)
	const hop = (url: URL): Effect.Effect<Hop, CancellationHomepageError | HttpClientError.HttpClientError> =>
		Effect.scoped(
			Effect.gen(function* () {
				if (
					url.protocol !== "https:" ||
					url.port !== "" ||
					url.username !== "" ||
					!isFetchableHost(url.hostname)
				) {
					return yield* new CancellationHomepageError({ message: `refused ${url.hostname}` })
				}
				const response = yield* scoped
					.execute(
						HttpClientRequest.get(url.href).pipe(
							HttpClientRequest.setHeaders({
								Accept: "text/html",
								"User-Agent": "Mozilla/5.0 (compatible; Maple/1.0)",
							}),
						),
					)
					.pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))
				const location = response.headers.location
				if (response.status >= 300 && response.status < 400 && location !== undefined) {
					if (!URL.canParse(location, url)) {
						return yield* new CancellationHomepageError({ message: "bad redirect" })
					}
					return { _tag: "Redirect", to: new URL(location, url) } satisfies Hop
				}
				if (response.status < 200 || response.status >= 300) {
					return yield* new CancellationHomepageError({ message: `HTTP ${response.status}` })
				}
				if (!(response.headers["content-type"] ?? "").includes("text/html")) {
					return yield* new CancellationHomepageError({ message: "not an HTML page" })
				}
				let size = 0
				const decoder = new TextDecoder()
				const chunks = yield* response.stream.pipe(
					Stream.takeUntil((chunk) => (size += chunk.length) >= HOMEPAGE_MAX_BYTES),
					Stream.runCollect,
				)
				// The last chunk can run past the limit.
				const html = chunks
					.map((chunk) => decoder.decode(chunk, { stream: true }))
					.join("")
					.slice(0, HOMEPAGE_MAX_BYTES)
				return { _tag: "Page", html } satisfies Hop
			}),
		)
	const get = (
		url: URL,
		redirects: number,
	): Effect.Effect<Homepage, CancellationHomepageError | HttpClientError.HttpClientError> =>
		hop(url).pipe(
			Effect.flatMap((result) => {
				if (result._tag === "Page")
					return Effect.succeed(homepageOf(domain, result.html, url.hostname))
				return redirects >= HOMEPAGE_MAX_REDIRECTS
					? Effect.fail(new CancellationHomepageError({ message: "too many redirects" }))
					: get(result.to, redirects + 1)
			}),
		)
	return get(new URL(`https://${domain}/`), 0).pipe(
		Effect.timeout(HOMEPAGE_TIMEOUT),
		Effect.withSpan("CancellationCompanyEvidenceReader.homepage", {
			attributes: { "maple.cancellation.homepage_domain": domain },
		}),
	)
}

export class CancellationCompanyEvidenceReader extends Context.Service<
	CancellationCompanyEvidenceReader,
	{ readonly read: (input: CancellationEvidenceInput) => Effect.Effect<Section> }
>()("@maple/backend/cancellation-review/CancellationCompanyEvidenceReader", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const organizations = yield* OrganizationService
		const members = yield* OrgMembersService
		const stripe = yield* StripeClient
		const client = yield* HttpClient.HttpClient

		/** A part that fails or is slow is null; the rest of the section still goes out. */
		const orNull = <A, E>(part: string, read: Effect.Effect<A, E>): Effect.Effect<A | null> =>
			read.pipe(
				Effect.map((value): A | null => value),
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.logWarning("cancellation company evidence could not read a part").pipe(
								Effect.annotateLogs({ part, error: summarizeCause(cause) }),
								Effect.as(null),
							),
				),
			)

		const read = Effect.fn("CancellationCompanyEvidenceReader.read")(function* (
			input: CancellationEvidenceInput,
		) {
			const emailDomains = input.members === null ? null : emailDomainsOf(input.members)
			// The members' most common company domain first; a site that refuses us, the next.
			const domains = (emailDomains?.company ?? [])
				.map((entry) => entry.domain)
				.filter(isFetchableHost)
				.slice(0, HOMEPAGE_DOMAINS_TRIED)
			const { orgName, billing, homepage, activity } = yield* Effect.all(
				{
					orgName: orNull(
						"orgName",
						organizations.retrieve(input.orgId).pipe(
							Effect.map((org) => org.name),
							Effect.timeout(SUB_READ_TIMEOUT),
							Effect.withSpan("CancellationCompanyEvidenceReader.orgName"),
						),
					),
					billing: orNull(
						"billing",
						(input.stripeCustomerId === null
							? Effect.succeed(null)
							: readBillingProfile(stripe, input.stripeCustomerId)
						).pipe(
							Effect.map(billingOf),
							Effect.timeout(SUB_READ_TIMEOUT),
							Effect.withSpan("CancellationCompanyEvidenceReader.billing"),
						),
					),
					homepage:
						domains.length === 0
							? Effect.succeed(null)
							: orNull(
									"homepage",
									Effect.firstSuccessOf(
										domains.map((domain) => fetchHomepage(client, domain)),
									),
								),
					activity: orNull(
						"people",
						members
							.listMemberActivity(input.orgId)
							.pipe(
								Effect.timeout(SUB_READ_TIMEOUT),
								Effect.withSpan("CancellationCompanyEvidenceReader.people"),
							),
					),
				},
				{ concurrency: "unbounded" },
			)
			const names: MemberNames = {
				words: memberNameWords(
					(input.members ?? []).map((member) => member.email),
					(activity ?? []).map((member) => member.name),
				),
				// A first name alone leaves a card holder's surname unchecked.
				complete:
					activity !== null &&
					activity.every((member) => (member.name?.trim().split(/\s+/).length ?? 0) >= 2),
			}
			return {
				...withoutPersonalNames(
					{ orgName, billing, homepage },
					names,
					(emailDomains?.company ?? []).map((entry) => entry.domain),
				),
				region: env.MAPLE_REGION,
				emailDomains,
				people: activity === null ? null : peopleOf(input.atMs, activity),
			} satisfies Section
		})

		return { read }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				OrganizationService.layer,
				OrgMembersService.layer,
				StripeClient.layer,
				FetchHttpClient.layer,
			),
		),
	)
}
