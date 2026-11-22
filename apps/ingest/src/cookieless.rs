//! Cookieless visitors: the browser SDK's `persistence: "cookieless"` keeps
//! nothing on the device and sends `visitor_id: "cookieless"`. The gateway
//! swaps that for a hash of a daily salt, the org, the client IP and the user
//! agent, so unique visitors count within a UTC day and never across days.
//!
//! The IP and user agent are only hashed, never stored. Each salt is deleted
//! after two days (`cookieless_salts`), after which no stored id can be
//! recomputed from an IP.

use std::collections::HashMap;
use std::net::IpAddr;

use hmac::{Hmac, Mac};
use sha2::Sha256;

/// What the SDK sends in `visitor_id` for a cookieless visitor.
pub const COOKIELESS_VISITOR_ID: &str = "cookieless";

/// A session start more than this long after the visitor's last one is a new visit,
/// matching the SDK's session idle timeout.
pub const VISIT_IDLE_MS: i64 = 30 * 60_000;

/// The UTC day of `now_ms` as `YYYY-MM-DD`, the key a salt is stored under.
#[must_use]
pub fn utc_day(now_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(now_ms)
        .unwrap_or_default()
        .format("%Y-%m-%d")
        .to_string()
}

/// The client address as hashed. IPv6 keeps only the /64: privacy extensions
/// rotate the interface half every day or so, which would split one visitor.
#[must_use]
pub fn normalize_ip(raw: &str) -> Option<String> {
    match raw.trim().parse::<IpAddr>().ok()? {
        IpAddr::V4(v4) => Some(v4.to_string()),
        IpAddr::V6(v6) => Some(v6.to_ipv4_mapped().map_or_else(
            || {
                let s = v6.segments();
                format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
            },
            |v4| v4.to_string(),
        )),
    }
}

/// The visitor id: HMAC-SHA256 keyed by the day's salt, shaped as a UUID so
/// `uniq(VisitorId)` and every reader of the column keep working.
#[must_use]
#[expect(
    clippy::expect_used,
    reason = "HMAC accepts keys of any length, so `new_from_slice` cannot fail here"
)]
pub fn visitor_id(salt: &[u8], org_id: &str, ip: &str, user_agent: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(salt).expect("hmac accepts any key length");
    for part in [org_id, ip, user_agent] {
        mac.update(part.as_bytes());
        mac.update(&[0]);
    }
    let digest = mac.finalize().into_bytes();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    uuid::Builder::from_random_bytes(bytes)
        .into_uuid()
        .to_string()
}

/// Whether the row asks for a cookieless visitor id.
#[must_use]
pub fn is_cookieless(obj: &serde_json::Map<String, serde_json::Value>) -> bool {
    obj.get("visitor_id").and_then(serde_json::Value::as_str) == Some(COOKIELESS_VISITOR_ID)
}

/// Replace the sentinel with `visitor` (`""` when none could be derived). A
/// cookieless visitor is never "new": the gateway cannot tell across days.
pub fn apply(obj: &mut serde_json::Map<String, serde_json::Value>, visitor: Option<&str>) {
    obj.insert(
        "visitor_id".to_owned(),
        serde_json::Value::String(visitor.unwrap_or_default().to_owned()),
    );
    if obj.contains_key("visitor_is_new") {
        obj.insert("visitor_is_new".to_owned(), serde_json::Value::from(0));
    }
}

/// Visit claims kept in process, for a gateway without a shared store
/// (self-hosted, one task). Visitor ids change daily, so the map is cleared
/// when the day does.
#[derive(Debug, Default)]
pub struct LocalVisits {
    day: String,
    last_seen_ms: HashMap<(String, String), i64>,
}

impl LocalVisits {
    /// Whether a session start at `now_ms` opens a new visit, extending it either way.
    pub fn claim(&mut self, org_id: &str, visitor_id: &str, now_ms: i64) -> bool {
        let day = utc_day(now_ms);
        if day != self.day {
            self.day = day;
            self.last_seen_ms.clear();
        }
        let previous = self
            .last_seen_ms
            .insert((org_id.to_owned(), visitor_id.to_owned()), now_ms);
        previous.is_none_or(|last| now_ms - last > VISIT_IDLE_MS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY_MS: i64 = 86_400_000;
    const NOON: i64 = 1_763_812_800_000; // 2025-11-22T12:00:00Z

    #[test]
    fn utc_day_formats_the_calendar_day() {
        assert_eq!(utc_day(NOON), "2025-11-22");
        assert_eq!(utc_day(NOON + DAY_MS / 2), "2025-11-23");
    }

    #[test]
    fn ipv6_keeps_the_network_half_and_mapped_v4_is_v4() {
        assert_eq!(
            normalize_ip("2001:db8:aa:bb:1111:2222:3333:4444"),
            normalize_ip("2001:db8:aa:bb:9999:8888:7777:6666"),
        );
        assert_ne!(
            normalize_ip("2001:db8:aa:bb::1"),
            normalize_ip("2001:db8:aa:cc::1"),
        );
        assert_eq!(
            normalize_ip("::ffff:203.0.113.7"),
            normalize_ip("203.0.113.7")
        );
        assert_eq!(normalize_ip("not an ip"), None);
    }

    #[test]
    fn visitor_id_is_stable_per_input_and_differs_per_salt_org_ip_and_agent() {
        let base = visitor_id(b"salt-a", "org_1", "203.0.113.7", "Firefox");
        assert_eq!(
            base,
            visitor_id(b"salt-a", "org_1", "203.0.113.7", "Firefox")
        );
        assert!(uuid::Uuid::parse_str(&base).is_ok());
        for other in [
            visitor_id(b"salt-b", "org_1", "203.0.113.7", "Firefox"),
            visitor_id(b"salt-a", "org_2", "203.0.113.7", "Firefox"),
            visitor_id(b"salt-a", "org_1", "203.0.113.8", "Firefox"),
            visitor_id(b"salt-a", "org_1", "203.0.113.7", "Chrome"),
        ] {
            assert_ne!(base, other);
        }
    }

    #[test]
    fn visitor_id_parts_cannot_be_shifted_across_the_separator() {
        assert_ne!(
            visitor_id(b"s", "org_1", "1.2.3.4", "ab"),
            visitor_id(b"s", "org_1a", "1.2.3.4", "b"),
        );
    }

    #[test]
    fn apply_replaces_the_sentinel_and_clears_new_visitor() {
        let mut row = serde_json::json!({ "visitor_id": "cookieless", "visitor_is_new": 1 });
        let obj = row.as_object_mut().unwrap();
        assert!(is_cookieless(obj));
        apply(obj, Some("v-1"));
        assert_eq!(
            row,
            serde_json::json!({ "visitor_id": "v-1", "visitor_is_new": 0 })
        );

        let mut row = serde_json::json!({ "visitor_id": "cookieless" });
        let obj = row.as_object_mut().unwrap();
        apply(obj, None);
        assert_eq!(row, serde_json::json!({ "visitor_id": "" }));
    }

    #[test]
    fn local_visits_open_a_new_visit_after_idle_and_on_a_new_day() {
        let mut visits = LocalVisits::default();
        assert!(visits.claim("org", "v", NOON));
        assert!(!visits.claim("org", "v", NOON + 10 * 60_000));
        // Extended by the last start, so 25 more minutes is still the same visit.
        assert!(!visits.claim("org", "v", NOON + 35 * 60_000));
        assert!(visits.claim("org", "v", NOON + 35 * 60_000 + VISIT_IDLE_MS + 1));
        assert!(visits.claim("org_other", "v", NOON + 36 * 60_000));
        assert!(visits.claim("org", "v", NOON + DAY_MS));
    }
}
