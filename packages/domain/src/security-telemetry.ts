// Catalog for the Security Center's Exposure tab: request paths that only scanners ask for, and
// the user agents of named scanning tools. Pure data, so the web bundle can import it; the SQL
// built from it lives in `tinybird/security-telemetry-columns.ts`.

export type ProbeCategory =
	| "secrets"
	| "source_control"
	| "debug_endpoints"
	| "path_traversal"
	| "admin_panels"
	| "exploits"
	| "cms"

export interface ProbeCategoryInfo {
	readonly id: ProbeCategory
	readonly label: string
	/** A success answer means the probe likely found something: the service served what was asked. */
	readonly critical: boolean
}

/** Categories in display order. */
export const PROBE_CATEGORIES: ReadonlyArray<ProbeCategoryInfo> = [
	{ id: "secrets", label: "Secrets and credential files", critical: true },
	{ id: "source_control", label: "Source control metadata", critical: true },
	{ id: "debug_endpoints", label: "Debug and status endpoints", critical: true },
	{ id: "path_traversal", label: "Path traversal", critical: true },
	{ id: "admin_panels", label: "Database admin panels", critical: true },
	{ id: "exploits", label: "Known exploit paths", critical: true },
	{ id: "cms", label: "WordPress", critical: false },
]

export interface ProbeSignature {
	/** Matched case-insensitively anywhere in the request path. */
	readonly token: string
	readonly category: ProbeCategory
}

/**
 * Paths a real application almost never serves. Tokens are specific on purpose: a bare `.php` or
 * `/admin` would mark every request of a PHP app or an admin UI as a probe.
 */
export const PROBE_SIGNATURES: ReadonlyArray<ProbeSignature> = [
	{ token: "/.env", category: "secrets" },
	{ token: "/.aws/", category: "secrets" },
	{ token: "/.ssh/", category: "secrets" },
	{ token: "/id_rsa", category: "secrets" },
	{ token: "/.npmrc", category: "secrets" },
	{ token: "/.htpasswd", category: "secrets" },
	{ token: "/.docker/config.json", category: "secrets" },
	{ token: "/.vscode/sftp.json", category: "secrets" },
	{ token: "/.s3cfg", category: "secrets" },
	{ token: "/wp-config.php", category: "secrets" },
	{ token: "/.git/", category: "source_control" },
	{ token: "/.svn/", category: "source_control" },
	{ token: "/.hg/", category: "source_control" },
	{ token: "/.ds_store", category: "source_control" },
	{ token: "/actuator/env", category: "debug_endpoints" },
	{ token: "/actuator/heapdump", category: "debug_endpoints" },
	{ token: "/actuator/configprops", category: "debug_endpoints" },
	{ token: "/actuator/gateway", category: "debug_endpoints" },
	{ token: "/server-status", category: "debug_endpoints" },
	{ token: "/server-info", category: "debug_endpoints" },
	{ token: "phpinfo", category: "debug_endpoints" },
	{ token: "/info.php", category: "debug_endpoints" },
	{ token: "/_profiler", category: "debug_endpoints" },
	{ token: "/debug/pprof", category: "debug_endpoints" },
	{ token: "/telescope/requests", category: "debug_endpoints" },
	{ token: "../", category: "path_traversal" },
	{ token: "..%2f", category: "path_traversal" },
	{ token: "%2e%2e", category: "path_traversal" },
	{ token: "/etc/passwd", category: "path_traversal" },
	{ token: "/proc/self/environ", category: "path_traversal" },
	{ token: "win.ini", category: "path_traversal" },
	{ token: "/phpmyadmin", category: "admin_panels" },
	{ token: "/pma/", category: "admin_panels" },
	{ token: "/adminer", category: "admin_panels" },
	{ token: "/vendor/phpunit", category: "exploits" },
	{ token: "eval-stdin.php", category: "exploits" },
	{ token: "/boaform", category: "exploits" },
	{ token: "/hnap1", category: "exploits" },
	{ token: "/goform/", category: "exploits" },
	{ token: "/cgi-bin/luci", category: "exploits" },
	{ token: "/wp-admin", category: "cms" },
	{ token: "/wp-login.php", category: "cms" },
	{ token: "/xmlrpc.php", category: "cms" },
	{ token: "/wp-includes/", category: "cms" },
	{ token: "/wp-content/plugins/", category: "cms" },
]

export interface ScannerAgent {
	/** Matched case-insensitively anywhere in the user agent. */
	readonly token: string
	readonly name: string
}

/** Scanning tools that name themselves. Generic clients (curl, python-requests) are left out. */
export const SCANNER_AGENTS: ReadonlyArray<ScannerAgent> = [
	{ token: "zgrab", name: "ZGrab" },
	{ token: "masscan", name: "Masscan" },
	{ token: "nuclei", name: "Nuclei" },
	{ token: "sqlmap", name: "sqlmap" },
	{ token: "nikto", name: "Nikto" },
	{ token: "nmap", name: "Nmap" },
	{ token: "gobuster", name: "Gobuster" },
	{ token: "dirbuster", name: "DirBuster" },
	{ token: "fuzz faster u fool", name: "ffuf" },
	{ token: "wpscan", name: "WPScan" },
	{ token: "whatweb", name: "WhatWeb" },
	{ token: "acunetix", name: "Acunetix" },
	{ token: "nessus", name: "Nessus" },
	{ token: "censysinspect", name: "Censys" },
	{ token: "palo alto networks", name: "Palo Alto Expanse" },
	{ token: "l9explore", name: "LeakIX" },
	{ token: "l9tcpid", name: "LeakIX" },
	{ token: "modatscanner", name: "Modat" },
	{ token: "internetmeasurement", name: "Driftnet" },
]

const CATEGORY_BY_TOKEN = new Map(PROBE_SIGNATURES.map((signature) => [signature.token, signature.category]))

/** The category of a stored `Signature`, undefined for `''` (a scanner request on an ordinary path). */
export const probeCategoryOf = (signature: string): ProbeCategory | undefined =>
	CATEGORY_BY_TOKEN.get(signature)

/** Signatures whose success answer is an exposure, for the exposed-probe query's filter. */
export const CRITICAL_PROBE_SIGNATURES: ReadonlyArray<string> = PROBE_SIGNATURES.filter(
	(signature) => PROBE_CATEGORIES.find((category) => category.id === signature.category)?.critical === true,
).map((signature) => signature.token)
