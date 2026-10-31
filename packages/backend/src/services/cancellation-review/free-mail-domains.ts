/**
 * Email domains that say nothing about who a member works for. Free-mail
 * domains are personal inboxes; disposable and reserved ones are throwaways
 * and test accounts. Every list matches the domain and its subdomains,
 * lowercase.
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
	"gmail.com",
	"googlemail.com",
	"outlook.com",
	"outlook.de",
	"outlook.fr",
	"hotmail.com",
	"hotmail.co.uk",
	"hotmail.de",
	"hotmail.fr",
	"hotmail.it",
	"live.com",
	"live.de",
	"live.fr",
	"msn.com",
	"yahoo.com",
	"yahoo.co.uk",
	"yahoo.de",
	"yahoo.fr",
	"yahoo.co.jp",
	"ymail.com",
	"aol.com",
	"icloud.com",
	"me.com",
	"mac.com",
	"proton.me",
	"protonmail.com",
	"protonmail.ch",
	"pm.me",
	"tutanota.com",
	"tutanota.de",
	"tuta.io",
	"gmx.de",
	"gmx.net",
	"gmx.com",
	"gmx.at",
	"gmx.ch",
	"web.de",
	"t-online.de",
	"freenet.de",
	"posteo.de",
	"mailbox.org",
	"hey.com",
	"fastmail.com",
	"fastmail.fm",
	"zoho.com",
	"zohomail.com",
	"yandex.com",
	"yandex.ru",
	"mail.ru",
	"qq.com",
	"163.com",
	"126.com",
	"sina.com",
	"naver.com",
	"hanmail.net",
	"orange.fr",
	"free.fr",
	"laposte.net",
	"libero.it",
	"seznam.cz",
	"wp.pl",
	"o2.pl",
	"interia.pl",
	"rediffmail.com",
	"comcast.net",
	"duck.com",
	"skiff.com",
	"foxmail.com",
	// Relays and no-reply addresses that hide the real inbox.
	"noreply.github.com",
	"privaterelay.appleid.com",
	"passmail.net",
	"passinbox.com",
	"mozmail.com",
	"slmail.me",
	"aleeas.com",
	"addy.io",
])

/**
 * Providers with an inbox under many country domains (`yahoo.com.br`,
 * `outlook.es`): the first label of a domain whose rest is a country or
 * generic ending.
 */
export const FREE_MAIL_PROVIDERS: ReadonlySet<string> = new Set([
	"gmail",
	"googlemail",
	"yahoo",
	"ymail",
	"rocketmail",
	"hotmail",
	"outlook",
	"live",
	"msn",
	"aol",
	"gmx",
	"yandex",
	"proton",
	"protonmail",
	"tutanota",
	"tuta",
	"zoho",
	"zohomail",
	"icloud",
	"mail",
	"fastmail",
	"simplelogin",
	"anonaddy",
])

/** Throwaway inboxes and the domains RFC 2606 / 6761 reserve for testing. */
export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
	"example.com",
	"example.org",
	"example.net",
	"mailinator.com",
	"guerrillamail.com",
	"sharklasers.com",
	"10minutemail.com",
	"temp-mail.org",
	"tempmail.com",
	"yopmail.com",
	"trashmail.com",
	"dispostable.com",
	"maildrop.cc",
	"getnada.com",
])

/** Reserved top-level names that never belong to a real organization. */
export const RESERVED_SUFFIXES: ReadonlyArray<string> = [
	".test",
	".example",
	".invalid",
	".localhost",
	".local",
	".internal",
]

/**
 * Wildcard DNS services: any name under them resolves to an address spelled in
 * the name, private ones included. Workers refuse to connect to a private
 * address anyway (Cloudflare error 1000); these are refused before asking.
 */
export const WILDCARD_DNS_DOMAINS: ReadonlySet<string> = new Set([
	"nip.io",
	"sslip.io",
	"xip.io",
	"localtest.me",
	"lvh.me",
	"traefik.me",
	"local.gd",
	"vcap.me",
])

/** Maple's own staff, invited into a customer's org to help: never the customer. */
export const MAPLE_DOMAINS: ReadonlySet<string> = new Set(["maple.dev"])
