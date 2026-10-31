// The name `/org-required` fills in: the company in a work email's domain, else the person's own team.

/** Mail providers by company label, so `yahoo.co.uk` and `outlook.de` count as personal too. */
const PERSONAL_EMAIL_PROVIDERS = new Set([
	"gmail",
	"googlemail",
	"outlook",
	"hotmail",
	"live",
	"msn",
	"yahoo",
	"ymail",
	"icloud",
	"me",
	"mac",
	"aol",
	"proton",
	"protonmail",
	"pm",
	"gmx",
	"web",
	"hey",
	"fastmail",
	"zoho",
	"yandex",
	"mail",
	"qq",
	"163",
	"orange",
	"free",
	"laposte",
	"t-online",
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
	const company = companyLabel(domain)
	// Punycode labels (`xn--…`) would read as noise, so they fall back to the person's name.
	const label =
		company === null || PERSONAL_EMAIL_PROVIDERS.has(company) || company.startsWith("xn--")
			? null
			: company
	if (label !== null && titleCase(label) !== "") return { name: titleCase(label), domain }
	const firstName = fullName?.trim().split(/\s+/)[0] ?? ""
	return { name: firstName === "" ? "My team" : `${firstName}'s team`, domain: null }
}
