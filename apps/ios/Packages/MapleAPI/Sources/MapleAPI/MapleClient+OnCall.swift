import Foundation

public typealias OnCallOverview = Components.Schemas.OnCallOverview
public typealias OnCallSchedule = Components.Schemas.OnCallOverviewSchedule
public typealias OnCallShift = Components.Schemas.OnCallOverviewShift
public typealias OnCallMyShift = Components.Schemas.OnCallMyShift
public typealias OnCallPerson = Components.Schemas.OnCallPerson
public typealias OnCallGap = Components.Schemas.OnCallGap

extension MapleClient {
	/// Who is on call on every schedule and when the caller is, in one read.
	/// Like the rest of `/v2/alerts`, it takes no environment parameter.
	public func onCallOverview() async throws -> OnCallOverview {
		try await mapping {
			try await client.getOnCallOverview(.init()).ok.body.json
		}
	}
}
