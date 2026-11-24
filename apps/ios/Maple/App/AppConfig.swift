import Foundation
import MapleAPI

/// Build-time configuration, injected via `Config/*.xcconfig` → Info.plist.
///
/// Nothing here is hardcoded in Swift: the Clerk publishable key comes from a
/// gitignored `Secrets.xcconfig`, and each region's API host is a server
/// declared in the OpenAPI document.
enum AppConfig {
	/// The placeholder shipped in `Base.xcconfig`, so a checkout that never
	/// created `Secrets.xcconfig` fails with a useful message instead of a 401.
	private static let placeholderKey = "pk_test_replace_me"

	static let clerkPublishableKey: String = {
		let key = string(forKey: "MapleClerkPublishableKey") ?? ""
		guard !key.isEmpty, key != placeholderKey else {
			fatalError(
				"""
				Missing Clerk publishable key.

				Copy apps/ios/Config/Secrets.example.xcconfig to Secrets.xcconfig and set
				CLERK_PUBLISHABLE_KEY (the same value as VITE_CLERK_PUBLISHABLE_KEY in
				.env.local), then rebuild.
				"""
			)
		}
		return key
	}()

	/// Each region's API host: the servers of the OpenAPI document, or, when
	/// `MAPLE_API_BASE_URL` is set, that one host for everything (a local API or
	/// a preview is a single instance).
	static let apiServers: APIServers = {
		if let apiBaseURL { return .single(apiBaseURL) }
		do {
			return try .production()
		} catch {
			fatalError("The OpenAPI document declares no usable servers: \(error)")
		}
	}()

	private static let apiBaseURL: URL? = {
		guard let value = string(forKey: "MapleAPIBaseURL"), !value.isEmpty else { return nil }

		// A hostless URL is almost always the xcconfig comment trap: `//` starts
		// a comment there, so `https://api.maple.dev` silently becomes `https:`.
		// URLSession then fails every request and the app reports "Can't reach
		// Maple", which sends you looking at the network instead of the config.
		guard let url = URL(string: value), url.host != nil else {
			fatalError(
				"""
				MAPLE_API_BASE_URL is not a usable URL: \(value)

				`//` starts a comment in xcconfig, so write the scheme separator with
				the escape: http:/$()/localhost:3472
				Or leave it empty to use the API declared in the OpenAPI document.
				"""
			)
		}
		return url
	}()

	/// The dashboard beside an API host: `api.maple.dev` -> `app.maple.dev`, and
	/// the same swap for EU (`api.eu.maple.dev`) and previews (`api-pr-12.maple.dev`).
	/// A local API maps to the local dashboard.
	static func webBaseURL(forAPI api: URL) -> URL {
		let fallback = URL(string: "https://app.maple.dev")!
		guard let host = api.host else { return fallback }
		if host == "localhost" || host == "127.0.0.1" { return URL(string: "http://localhost:3471")! }
		guard host.hasPrefix("api") else { return fallback }
		var components = URLComponents()
		components.scheme = api.scheme ?? "https"
		components.host = "app" + host.dropFirst(3)
		return components.url ?? fallback
	}

	private static func string(forKey key: String) -> String? {
		(Bundle.main.object(forInfoDictionaryKey: key) as? String)?
			.trimmingCharacters(in: .whitespacesAndNewlines)
	}
}
