import MapleAPI

extension TimeWindow {
	/// `1h`, `6h`, `24h`, `7d`: window chips and status lines.
	var compactTitle: String {
		switch self {
		case .lastHour: "1h"
		case .last6Hours: "6h"
		case .last24Hours: "24h"
		case .last7Days: "7d"
		}
	}

	/// `Last 1h`: the time range chip and pill.
	var chipTitle: String { "Last \(compactTitle)" }
}
