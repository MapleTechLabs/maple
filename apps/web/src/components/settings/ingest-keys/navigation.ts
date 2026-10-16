import { useNavigate } from "@tanstack/react-router"
import { Atom, Result, useAtomValue } from "@/lib/effect-atom"
import { customIngestKeysListAtom } from "@/lib/services/atoms/ingestion-atoms"
import { toPublicKeyId } from "./shared"

export const ingestionViews = ["setup", "keys", "mappings"] as const
export type IngestionView = (typeof ingestionViews)[number]

/** `/settings?tab=ingestion&view=keys&key=<ingk_…|new>&keyView=configure` */
export function useIngestionNavigation() {
	const navigate = useNavigate({ from: "/settings" })
	const go = (search: { view?: IngestionView; key?: string; keyView?: "configure" }) =>
		navigate({ search: { tab: "ingestion", ...search } })
	return {
		openView: (view: IngestionView) => go({ view }),
		openKeys: () => go({ view: "keys" }),
		openNewKey: () => go({ view: "keys", key: "new" }),
		openKey: (publicId: string) => go({ view: "keys", key: publicId }),
		configureKey: (publicId: string) => go({ view: "keys", key: publicId, keyView: "configure" }),
	}
}

// Read in place of the key list off key pages, so other settings tabs never fetch it.
const noKeysAtom = Atom.make(Result.success({ data: [] }))

/** Trailing breadcrumbs for a key page: the key's name, then "Configure". */
export function useIngestKeyCrumbs(
	keyParam: string | undefined,
	keyView: "configure" | undefined,
): ReadonlyArray<{ label: string; href?: string }> {
	const listResult = useAtomValue(
		keyParam === undefined || keyParam === "new" ? noKeysAtom : customIngestKeysListAtom,
	)
	if (keyParam === undefined) return []
	if (keyParam === "new") return [{ label: "New key" }]
	const name = Result.builder(listResult)
		.onSuccess((response) => response.data.find((key) => toPublicKeyId(key.id) === keyParam)?.name)
		.orElse(() => undefined)
	const label = name ?? "Key"
	return keyView === "configure"
		? [
				{ label, href: `/settings?tab=ingestion&view=keys&key=${encodeURIComponent(keyParam)}` },
				{ label: "Configure" },
			]
		: [{ label }]
}
