import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

// Module-level singletons. `AtomHttpApi.query` keys its `Atom.family` by the request object — so
// every consumer must import these exact atoms to share one fetch (and so a refresh from one
// surface invalidates the data everywhere it's read).
//
// These two lists are data-coupled: the recommendation list is reconciled server-side against the
// attribute mappings (creating a mapping that covers a recommendation flips it to `applied`;
// applying a recommendation creates a mapping). Mutations on either side must refresh both atoms so
// the ingestion settings page stays consistent — see attribute-mappings-section.tsx and
// recommended-mappings-section.tsx.
export const ingestAttributeMappingsListAtom = MapleApiAtomClient.query("ingestAttributeMappings", "list", {})

export const recommendationIssuesListAtom = MapleApiAtomClient.query("recommendationIssues", "list", {})
