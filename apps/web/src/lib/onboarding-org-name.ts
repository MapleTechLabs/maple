// The name `/org-required` fills in: the company in a work email's domain, else the person's own team.

const PERSONAL_EMAIL_DOMAINS = new Set([
	"gmail.com",
	"googlemail.com",
	"outlook.com",
	"hotmail.com",
	"live.com",
	"msn.com",
	"yahoo.com",
	"icloud.com",
	"me.com",
	"mac.com",
	"aol.com",
	"proton.me",
	"protonmail.com",
	"pm.me",
	"gmx.com",
	"gmx.de",
	"web.de",
	"hey.com",
	"fastmail.com",
	"zoho.com",
	"yandex.com",
	"mail.com",
	"qq.com",
	"163.com",
])

/** Second-level labels that sit under a country code (`acme.co.uk`), so the company is one further left. */
const SECOND_LEVEL_LABELS = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ne", "or"])

const titleCase = (label: string): string =>
	label
		.split(/[-_]+/)
		.filter((word) => word.length > 0)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ")

/** The company label of a domain: `mail.acme.co.uk` and `acme.dev` are both `acme`. */
const companyLabel = (domain: string): string | null => {
	const labels = domain.split(".").filter((label) => label.length > 0)
	if (labels.length < 2) return null
	const topLevel = labels.at(-1) ?? ""
	const underCountryCode =
		labels.length >= 3 && topLevel.length === 2 && SECOND_LEVEL_LABELS.has(labels.at(-2) ?? "")
	return labels.at(underCountryCode ? -3 : -2) ?? null
}

export type SuggestedOrganizationName = Readonly<{
	name: string
	/** The work domain the name came from, shown as the hint; `null` for a personal address. */
	domain: string | null
}>

export const suggestOrganizationName = (
	email: string | null,
	fullName: string | null,
): SuggestedOrganizationName => {
	const domain = email?.split("@")[1]?.trim().toLowerCase() ?? ""
	const label = domain === "" || PERSONAL_EMAIL_DOMAINS.has(domain) ? null : companyLabel(domain)
	if (label !== null && titleCase(label) !== "") return { name: titleCase(label), domain }
	const firstName = fullName?.trim().split(/\s+/)[0] ?? ""
	return { name: firstName === "" ? "My team" : `${firstName}'s team`, domain: null }
}
