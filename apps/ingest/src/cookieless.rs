//! Cookieless visitors: the browser SDK's `persistence: "cookieless"` keeps
//! nothing on the device and sends `visitor_id: "cookieless"`. The gateway
//! swaps that for a hash of a daily salt, the org, the client IP and the user
//! agent, so unique visitors count within a UTC day and never across days.
//!
//! The IP is only hashed, never stored. The user agent is hashed here too, though
//! it also reaches the warehouse on its own: the SDK's `user_agent` column and the
//! gateway's request spans (`record_client_identity`) carry it, as for every
//! session. Each salt is deleted after two days (`cookieless_salts`), after which
//! no stored id can be recomputed from an IP.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};

use hmac::{Hmac, Mac};
use sha2::Sha256;

/// What the SDK sends in `visitor_id` for a cookieless visitor.
pub const COOKIELESS_VISITOR_ID: &str = "cookieless";

/// `visitor_is_new` for a cookieless row: unknown, so neither the new nor the returning count.
pub const VISITOR_IS_NEW_UNKNOWN: u8 = 2;

/// How often one task extends a visitor's visit from heartbeats.
pub const VISIT_TOUCH_INTERVAL_MS: i64 = 2 * 60_000;

/// Bound on the in-process maps, which reset when full: a lost entry costs one extra write.
const MAX_TRACKED_VISITORS: usize = 200_000;

/// A session start more than this long after the visitor's last one is a new visit,
/// matching the SDK's session idle timeout.
pub const VISIT_IDLE_MS: i64 = 30 * 60_000;

/// The idle bound the gateway applies: the SDK's window plus the touch throttle, since a
/// stored `last_seen_at` can lag the latest heartbeat by one interval. Errs toward billing less.
pub const VISIT_WINDOW_MS: i64 = VISIT_IDLE_MS + VISIT_TOUCH_INTERVAL_MS;

/// The UTC day of `now_ms` as `YYYY-MM-DD`, the key a salt is stored under.
#[must_use]
pub fn utc_day(now_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(now_ms)
        .unwrap_or_default()
        .format("%Y-%m-%d")
        .to_string()
}

/// Headers that can name the visitor's address, read in this order. The first that
/// holds a public address wins, so a first-party proxy that sets `X-Forwarded-For` is
/// honored instead of hashing every visitor as the proxy's IP. Without a proxy the edge
/// puts the client's address in `X-Forwarded-For` too, so direct traffic hashes as before.
/// A client can spoof these, but only to pick its own visitor id, which a public ingest
/// key already allows through `visitor_id`.
pub const CLIENT_IP_HEADERS: [&str; 7] = [
    "x-forwarded-for",
    "forwarded",
    "x-real-ip",
    "fly-client-ip",
    "true-client-ip",
    "cf-connecting-ip",
    "cloudfront-viewer-address",
];

/// The visitor's address from the first of `CLIENT_IP_HEADERS` that holds a public one,
/// normalized for hashing. `header` returns a header's value by lowercase name. In a
/// list, the leftmost public entry is taken: a private hop (an office proxy's `10.x`) is
/// shared by many people and would merge them into one visitor.
#[must_use]
pub fn client_ip(header: impl Fn(&str) -> Option<String>) -> Option<String> {
    CLIENT_IP_HEADERS.iter().find_map(|name| {
        let value = header(name)?;
        let ip = match *name {
            "x-forwarded-for" => value.split(',').find_map(public_addr),
            "forwarded" => value
                .split(',')
                .filter_map(forwarded_for)
                .find_map(public_addr),
            _ => public_addr(&value),
        }?;
        normalize_ip(&ip.to_string())
    })
}

/// The `for=` of one element of an RFC 7239 `Forwarded` header.
fn forwarded_for(element: &str) -> Option<&str> {
    element.split(';').find_map(|pair| {
        let (key, addr) = pair.split_once('=')?;
        key.trim().eq_ignore_ascii_case("for").then_some(addr)
    })
}

fn public_addr(raw: &str) -> Option<IpAddr> {
    parse_addr(raw).filter(|ip| is_public(*ip))
}

/// Not loopback, private, link-local, carrier-grade NAT or unspecified.
fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || (a == 100 && (64..128).contains(&b)))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80)
        }
    }
}

/// An address with an optional port: `203.0.113.7`, `203.0.113.7:443`, `"[2001:db8::1]:443"`,
/// or CloudFront's unbracketed `2001:db8::1:443`. Obfuscated or `unknown` values are `None`.
fn parse_addr(raw: &str) -> Option<IpAddr> {
    let raw = raw.trim().trim_matches('"');
    raw.parse::<IpAddr>()
        .ok()
        .or_else(|| raw.parse::<SocketAddr>().ok().map(|socket| socket.ip()))
        .or_else(|| raw.strip_prefix('[')?.strip_suffix(']')?.parse().ok())
        .or_else(|| raw.rsplit_once(':')?.0.parse().ok())
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

/// Replace the sentinel with `visitor` (`""` when none could be derived). Whether a
/// cookieless visitor is new is unknown: the gateway cannot tell across days.
pub fn apply(obj: &mut serde_json::Map<String, serde_json::Value>, visitor: Option<&str>) {
    obj.insert(
        "visitor_id".to_owned(),
        serde_json::Value::String(visitor.unwrap_or_default().to_owned()),
    );
    // Only an identified row has a history to be unknown; an unidentified one is not new.
    if obj.contains_key("visitor_is_new") {
        let is_new = if visitor.is_some() { VISITOR_IS_NEW_UNKNOWN } else { 0 };
        obj.insert("visitor_is_new".to_owned(), serde_json::Value::from(is_new));
    }
}

/// Remove a client-supplied `maple.visitor.mode`: only the gateway sets it.
pub fn clear_metadata_mark(obj: &mut serde_json::Map<String, serde_json::Value>) {
    if let Some(attributes) = obj
        .get_mut("resource_attributes")
        .and_then(serde_json::Value::as_object_mut)
    {
        attributes.remove(VISITOR_MODE_ATTRIBUTE);
    }
}

const VISITOR_MODE_ATTRIBUTE: &str = "maple.visitor.mode";

/// Mark an identified cookieless metadata row: `maple.visitor.mode` and an unknown history,
/// whether or not the client sent `visitor_is_new` (the column default 0 reads as returning).
pub fn mark_metadata_row(obj: &mut serde_json::Map<String, serde_json::Value>) {
    obj.insert(
        "visitor_is_new".to_owned(),
        serde_json::Value::from(VISITOR_IS_NEW_UNKNOWN),
    );
    let attributes = obj
        .entry("resource_attributes")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    if !attributes.is_object() {
        *attributes = serde_json::Value::Object(serde_json::Map::new());
    }
    if let Some(map) = attributes.as_object_mut() {
        map.insert(
            VISITOR_MODE_ATTRIBUTE.to_owned(),
            serde_json::Value::String("cookieless".to_owned()),
        );
    }
}

/// Visit claims kept in process, for a gateway without a shared store
/// (self-hosted, one task). Visitor ids change daily, so the map is cleared
/// when the day does.
#[derive(Debug)]
pub struct LocalVisits {
    day: String,
    last_seen_ms: HashMap<(String, String), i64>,
    capacity: usize,
    last_sweep_ms: i64,
}

const SWEEP_INTERVAL_MS: i64 = 60_000;

impl Default for LocalVisits {
    fn default() -> Self {
        Self::with_capacity(MAX_TRACKED_VISITORS)
    }
}

impl LocalVisits {
    /// Whether a session start at `now_ms` opens a new visit, extending it either way.
    /// A full map of open visits admits no new visitor: it is not counted (only ever
    /// billing less) until visits go idle, so the map stays bounded.
    pub fn claim(&mut self, org_id: &str, visitor_id: &str, now_ms: i64) -> bool {
        self.roll(now_ms);
        let key = (org_id.to_owned(), visitor_id.to_owned());
        if !self.last_seen_ms.contains_key(&key) && self.last_seen_ms.len() >= self.capacity {
            return false;
        }
        let previous = self.last_seen_ms.insert(key, now_ms);
        previous.is_none_or(|last| now_ms - last > VISIT_WINDOW_MS)
    }

    #[must_use]
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            day: String::new(),
            last_seen_ms: HashMap::new(),
            capacity,
            last_sweep_ms: i64::MIN / 2,
        }
    }

    /// Extend a visit still open from a heartbeat, without opening or reopening one.
    pub fn touch(&mut self, org_id: &str, visitor_id: &str, now_ms: i64) {
        self.roll(now_ms);
        if let Some(last) = self
            .last_seen_ms
            .get_mut(&(org_id.to_owned(), visitor_id.to_owned()))
        {
            if now_ms - *last <= VISIT_WINDOW_MS {
                *last = now_ms;
            }
        }
    }

    /// A new day clears the map; a full one drops only visits already idle, so an open
    /// visit is never forgotten (and re-billed) to make room. The sweep runs at most once
    /// a minute, so a full map of open visits does not cost a scan per request.
    fn roll(&mut self, now_ms: i64) {
        let day = utc_day(now_ms);
        if day != self.day {
            self.day = day;
            self.last_seen_ms.clear();
        } else if self.last_seen_ms.len() >= self.capacity
            && now_ms - self.last_sweep_ms >= SWEEP_INTERVAL_MS
        {
            self.last_sweep_ms = now_ms;
            self.last_seen_ms
                .retain(|_, last| now_ms - *last <= VISIT_WINDOW_MS);
        }
    }
}

/// Per-task throttle on heartbeat touches, so a busy visitor costs one write per interval.
#[derive(Debug, Default)]
pub struct TouchThrottle {
    last_touch_ms: HashMap<(String, String), i64>,
}

impl TouchThrottle {
    /// Whether a touch at `now_ms` is due, recording it when it is.
    pub fn due(&mut self, org_id: &str, visitor_id: &str, now_ms: i64) -> bool {
        if self.last_touch_ms.len() >= MAX_TRACKED_VISITORS {
            self.last_touch_ms.clear();
        }
        let key = (org_id.to_owned(), visitor_id.to_owned());
        match self.last_touch_ms.get(&key) {
            Some(last) if now_ms - last < VISIT_TOUCH_INTERVAL_MS => false,
            _ => {
                self.last_touch_ms.insert(key, now_ms);
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY_MS: i64 = 86_400_000;

    /// A fresh random salt, as the gateway mints one per day.
    fn random_salt() -> [u8; 16] {
        *uuid::Uuid::new_v4().as_bytes()
    }
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

    fn lookup<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        }
    }

    #[test]
    fn client_ip_reads_the_first_header_in_order_that_holds_an_address() {
        let proxied = [
            ("cf-connecting-ip", "192.0.2.1"),
            ("x-forwarded-for", " 203.0.113.7 , 10.0.0.1, 192.0.2.1"),
        ];
        assert_eq!(client_ip(lookup(&proxied)).as_deref(), Some("203.0.113.7"));
        assert_eq!(
            client_ip(lookup(&[("cf-connecting-ip", "192.0.2.1")])).as_deref(),
            Some("192.0.2.1")
        );
        let garbled = [
            ("x-forwarded-for", "unknown"),
            ("x-real-ip", "198.51.100.2"),
        ];
        assert_eq!(client_ip(lookup(&garbled)).as_deref(), Some("198.51.100.2"));
        assert_eq!(client_ip(lookup(&[])), None);
    }

    #[test]
    fn client_ip_skips_private_hops_and_falls_back_to_the_edge_address() {
        let office = [("x-forwarded-for", "10.1.2.3, 203.0.113.7, 192.0.2.1")];
        assert_eq!(client_ip(lookup(&office)).as_deref(), Some("203.0.113.7"));
        let all_private = [
            ("x-forwarded-for", "10.1.2.3, 172.16.0.9"),
            ("x-real-ip", "127.0.0.1"),
            ("cf-connecting-ip", "198.51.100.2"),
        ];
        assert_eq!(client_ip(lookup(&all_private)).as_deref(), Some("198.51.100.2"));
        let forwarded = [("forwarded", "for=192.168.0.4, for=\"[fd00::1]\", for=203.0.113.7")];
        assert_eq!(client_ip(lookup(&forwarded)).as_deref(), Some("203.0.113.7"));
        assert_eq!(client_ip(lookup(&[("x-real-ip", "100.64.3.4")])), None);
    }

    #[test]
    fn client_ip_parses_ports_brackets_and_forwarded_pairs() {
        let cases: [(&str, &str, &str); 6] = [
            ("x-forwarded-for", "203.0.113.7:51234", "203.0.113.7"),
            (
                "x-forwarded-for",
                "[2001:db8:aa:bb::1]:443",
                "2001:db8:aa:bb::/64",
            ),
            (
                "forwarded",
                r#"proto=https;For="[2001:db8:aa:bb::1]:443", for=192.0.2.1"#,
                "2001:db8:aa:bb::/64",
            ),
            ("forwarded", "for=203.0.113.7;by=10.0.0.1", "203.0.113.7"),
            (
                "cloudfront-viewer-address",
                "2001:db8:aa:bb::1:46532",
                "2001:db8:aa:bb::/64",
            ),
            (
                "cloudfront-viewer-address",
                "203.0.113.7:46532",
                "203.0.113.7",
            ),
        ];
        for (name, value, expected) in cases {
            assert_eq!(
                client_ip(lookup(&[(name, value)])).as_deref(),
                Some(expected),
                "{name}: {value}"
            );
        }
        assert_eq!(client_ip(lookup(&[("forwarded", "for=_hidden")])), None);
    }

    #[test]
    fn visitor_id_is_stable_per_input_and_differs_per_salt_org_ip_and_agent() {
        let (salt_a, salt_b) = (random_salt(), random_salt());
        let base = visitor_id(&salt_a, "org_1", "203.0.113.7", "Firefox");
        assert_eq!(
            base,
            visitor_id(&salt_a, "org_1", "203.0.113.7", "Firefox")
        );
        assert!(uuid::Uuid::parse_str(&base).is_ok());
        for other in [
            visitor_id(&salt_b, "org_1", "203.0.113.7", "Firefox"),
            visitor_id(&salt_a, "org_2", "203.0.113.7", "Firefox"),
            visitor_id(&salt_a, "org_1", "203.0.113.8", "Firefox"),
            visitor_id(&salt_a, "org_1", "203.0.113.7", "Chrome"),
        ] {
            assert_ne!(base, other);
        }
    }

    #[test]
    fn visitor_id_parts_cannot_be_shifted_across_the_separator() {
        let salt = random_salt();
        assert_ne!(
            visitor_id(&salt, "org_1", "1.2.3.4", "ab"),
            visitor_id(&salt, "org_1a", "1.2.3.4", "b"),
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
            serde_json::json!({ "visitor_id": "v-1", "visitor_is_new": 2 })
        );

        let mut row = serde_json::json!({ "visitor_id": "cookieless", "visitor_is_new": 1 });
        let obj = row.as_object_mut().unwrap();
        apply(obj, None);
        assert_eq!(row, serde_json::json!({ "visitor_id": "", "visitor_is_new": 0 }));
    }

    #[test]
    fn local_visits_open_a_new_visit_after_idle_and_on_a_new_day() {
        let mut visits = LocalVisits::default();
        assert!(visits.claim("org", "v", NOON));
        assert!(!visits.claim("org", "v", NOON + 10 * 60_000));
        // Extended by the last start, so 25 more minutes is still the same visit.
        assert!(!visits.claim("org", "v", NOON + 35 * 60_000));
        assert!(visits.claim("org", "v", NOON + 35 * 60_000 + VISIT_WINDOW_MS + 1));
        assert!(visits.claim("org_other", "v", NOON + 36 * 60_000));
        assert!(visits.claim("org", "v", NOON + DAY_MS));
    }

    #[test]
    fn a_touch_keeps_an_active_visit_open_past_the_idle_window() {
        let mut visits = LocalVisits::default();
        assert!(visits.claim("org", "v", NOON));
        visits.touch("org", "v", NOON + 25 * 60_000);
        assert!(!visits.claim("org", "v", NOON + 40 * 60_000));
        // A touch never opens a visit for a visitor with none.
        visits.touch("org", "w", NOON);
        assert!(visits.claim("org", "w", NOON + 60_000));
    }

    #[test]
    fn touches_are_throttled_per_visitor() {
        let mut throttle = TouchThrottle::default();
        assert!(throttle.due("org", "v", NOON));
        assert!(!throttle.due("org", "v", NOON + 60_000));
        assert!(throttle.due("org", "w", NOON + 60_000));
        assert!(throttle.due("org", "v", NOON + VISIT_TOUCH_INTERVAL_MS));
    }

    #[test]
    fn a_metadata_row_is_marked_cookieless_beside_its_other_attributes() {
        let mut row = serde_json::json!({ "resource_attributes": { "service.name": "web" } });
        mark_metadata_row(row.as_object_mut().unwrap());
        assert_eq!(
            row["resource_attributes"],
            serde_json::json!({ "service.name": "web", "maple.visitor.mode": "cookieless" })
        );

        let mut bare = serde_json::json!({ "resource_attributes": "not a map" });
        mark_metadata_row(bare.as_object_mut().unwrap());
        assert_eq!(bare["resource_attributes"]["maple.visitor.mode"], "cookieless");
    }

    #[test]
    fn a_late_heartbeat_never_reopens_an_expired_visit() {
        let mut visits = LocalVisits::default();
        assert!(visits.claim("org", "v", NOON));
        visits.touch("org", "v", NOON + VISIT_WINDOW_MS + 60_000);
        assert!(visits.claim("org", "v", NOON + VISIT_WINDOW_MS + 120_000));
    }

    #[test]
    fn the_mode_marker_is_the_gateways_alone() {
        let mut row = serde_json::json!({
            "visitor_is_new": 1,
            "resource_attributes": { "maple.visitor.mode": "cookieless", "service.name": "web" }
        });
        clear_metadata_mark(row.as_object_mut().unwrap());
        assert_eq!(row["resource_attributes"], serde_json::json!({ "service.name": "web" }));

        let mut identified = serde_json::json!({});
        mark_metadata_row(identified.as_object_mut().unwrap());
        assert_eq!(identified["visitor_is_new"], 2, "unknown even when the client sent none");
    }

    #[test]
    fn a_full_map_keeps_open_visits_and_admits_no_new_visitor_until_one_goes_idle() {
        let mut visits = LocalVisits::with_capacity(2);
        assert!(visits.claim("org", "a", NOON));
        assert!(visits.claim("org", "b", NOON));
        assert!(!visits.claim("org", "c", NOON + 60_000), "full of open visits");
        assert!(!visits.claim("org", "a", NOON + 120_000), "a's open visit survives");
        // Once a and b go idle, the full map drops them and admits c.
        assert!(visits.claim("org", "c", NOON + 120_000 + VISIT_WINDOW_MS + 1));
    }

    #[test]
    fn a_throttled_heartbeat_cannot_end_a_visit_early() {
        // Touch written at 12:29, the 12:30 heartbeat throttled, a start at 12:59:31.
        let mut visits = LocalVisits::default();
        assert!(visits.claim("org", "v", NOON));
        visits.touch("org", "v", NOON + 29 * 60_000);
        assert!(!visits.claim("org", "v", NOON + 59 * 60_000 + 31_000));
    }
}
