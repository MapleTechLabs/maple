import ClerkKit
import MapleAPI

extension Organization {
	/// Where the organization's data lives, from the `regions` key of its public
	/// metadata: the same source and rule as the server's `organizationHomeRegion`.
	var mapleRegion: MapleRegion {
		MapleRegion.home(ofRegions: publicMetadata?.objectValue?["regions"]?.arrayValue?.map(\.stringValue))
	}
}

extension OrganizationRegions {
	func record(_ organizations: [Organization]) {
		record(Dictionary(organizations.map { ($0.id, $0.mapleRegion) }, uniquingKeysWith: { _, latest in latest }))
	}

	/// What Clerk restored from the keychain, so a launch (including a background
	/// wake that never loads memberships) can route before the list arrives.
	@MainActor
	func recordRestoredSession() {
		record((Clerk.shared.user?.organizationMemberships ?? []).map(\.organization))
		if let active = Clerk.shared.organization { record([active]) }
	}
}
