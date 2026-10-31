//! Guards for requests to tenant-configured hosts (BYO ClickHouse): connect only
//! to public addresses, and read no more of a response than the caller can use.

use std::fmt;
use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};

/// Whether `ip` is routable on the public internet. Mirrors `@maple/safe-fetch`:
/// loopback, private, link-local (cloud metadata), CGNAT, ULA, multicast,
/// documentation and reserved ranges are not, nor IPv6 forms that embed one.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 100 && (64..=127).contains(&b))
        || (a == 198 && (b == 18 || b == 19))
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

fn v4_from(hi: u16, lo: u16) -> Ipv4Addr {
    let [a, b] = hi.to_be_bytes();
    let [c, d] = lo.to_be_bytes();
    Ipv4Addr::new(a, b, c, d)
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    let g = ip.segments();
    let zero = |range: std::ops::Range<usize>| g[range].iter().all(|s| *s == 0);
    // Unspecified, loopback and IPv4-compatible `::a.b.c.d`.
    if zero(0..6) {
        return false;
    }
    // ULA, multicast, link-local, site-local.
    if (g[0] & 0xfe00) == 0xfc00 || (g[0] & 0xff00) == 0xff00 {
        return false;
    }
    if (g[0] & 0xffc0) == 0xfe80 || (g[0] & 0xffc0) == 0xfec0 {
        return false;
    }
    // SIIT `::ffff:0:a.b.c.d`, NAT64 local-use, Teredo.
    if zero(0..4) && g[4] == 0xffff && g[5] == 0 {
        return false;
    }
    if g[0] == 0x64 && g[1] == 0xff9b && g[2] == 1 {
        return false;
    }
    if g[0] == 0x2001 && g[1] == 0 {
        return false;
    }
    // Mapped, NAT64 and 6to4 carry an IPv4 address that faces the IPv4 rules.
    if zero(0..5) && g[5] == 0xffff {
        return is_public_v4(v4_from(g[6], g[7]));
    }
    if g[0] == 0x64 && g[1] == 0xff9b && zero(2..6) {
        return is_public_v4(v4_from(g[6], g[7]));
    }
    if g[0] == 0x2002 {
        return is_public_v4(v4_from(g[1], g[2]));
    }
    true
}

/// A tenant host that resolved (or was written as) a non-public address.
#[derive(Debug)]
pub struct BlockedAddress {
    pub host: String,
    pub ip: IpAddr,
}

impl fmt::Display for BlockedAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} resolves to a non-public address", self.host)
    }
}

impl std::error::Error for BlockedAddress {}

/// Whether a request failed because its host was a non-public address.
pub fn is_blocked_address(error: &(dyn std::error::Error + 'static)) -> bool {
    std::iter::successors(Some(error), |e| e.source())
        .any(<dyn std::error::Error>::is::<BlockedAddress>)
}

/// The literal IP host of `url` when it is not public. Literal hosts never
/// reach a resolver, so they are checked here before the request is built.
pub fn blocked_literal_host(url: &url::Url) -> Option<BlockedAddress> {
    let ip = match url.host()? {
        url::Host::Ipv4(v4) => IpAddr::V4(v4),
        url::Host::Ipv6(v6) => IpAddr::V6(v6),
        url::Host::Domain(_) => return None,
    };
    (!is_public_ip(ip)).then(|| BlockedAddress {
        host: ip.to_string(),
        ip,
    })
}

pub type LookupFuture = Pin<Box<dyn Future<Output = io::Result<Vec<IpAddr>>> + Send>>;
pub type Lookup = Arc<dyn Fn(String) -> LookupFuture + Send + Sync>;

/// A `reqwest` resolver that hands the connector only public addresses: a name
/// with any non-public answer fails, so the address checked is the one dialled
/// and a re-resolved (rebound) name cannot reach the private network.
#[derive(Clone)]
pub struct PublicOnlyResolver {
    lookup: Lookup,
}

impl PublicOnlyResolver {
    /// Over the system resolver.
    pub fn system() -> Self {
        Self::with_lookup(Arc::new(|host: String| {
            Box::pin(async move {
                let addrs = tokio::net::lookup_host((host.as_str(), 0)).await?;
                Ok(addrs.map(|addr| addr.ip()).collect())
            })
        }))
    }

    pub fn with_lookup(lookup: Lookup) -> Self {
        Self { lookup }
    }
}

impl fmt::Debug for PublicOnlyResolver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PublicOnlyResolver")
    }
}

impl Resolve for PublicOnlyResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        let lookup = Arc::clone(&self.lookup);
        Box::pin(async move {
            let ips = lookup(host.clone()).await?;
            if ips.is_empty() {
                return Err(format!("{host} resolved to no addresses").into());
            }
            if let Some(ip) = ips.iter().copied().find(|ip| !is_public_ip(*ip)) {
                return Err(BlockedAddress { host, ip }.into());
            }
            let addrs: Addrs = Box::new(ips.into_iter().map(|ip| SocketAddr::new(ip, 0)));
            Ok(addrs)
        })
    }
}

/// At most `max_bytes` of a response body as (lossy) UTF-8. Reads chunk by
/// chunk and stops at the budget, so a large or endless body is never buffered;
/// a read error ends the body where it is.
pub async fn read_body_capped(mut response: reqwest::Response, max_bytes: usize) -> String {
    let mut body: Vec<u8> = Vec::new();
    while body.len() < max_bytes {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                let room = max_bytes - body.len();
                body.extend_from_slice(&chunk[..chunk.len().min(room)]);
            }
            Ok(None) | Err(_) => break,
        }
    }
    String::from_utf8_lossy(&body).into_owned()
}

/// A client builder for tenant-configured hosts: no redirects (a bounce could
/// point anywhere), no proxy (the resolver must see the target name), and, given
/// a `resolver`, only public addresses dialled. `None` is the private-network opt-in.
pub fn tenant_client_builder(resolver: Option<PublicOnlyResolver>) -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy();
    match resolver {
        Some(resolver) => builder.dns_resolver(resolver),
        None => builder,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::str::FromStr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    type Serve = Pin<Box<dyn Future<Output = ()> + Send>>;

    fn fake_dns(records: &[(&str, &[&str])]) -> PublicOnlyResolver {
        let map: HashMap<String, Vec<IpAddr>> = records
            .iter()
            .map(|(name, ips)| {
                let ips = ips.iter().map(|ip| ip.parse().unwrap()).collect();
                ((*name).to_owned(), ips)
            })
            .collect();
        let map = Arc::new(map);
        PublicOnlyResolver::with_lookup(Arc::new(move |host: String| {
            let answer = map.get(&host).cloned();
            Box::pin(async move { answer.ok_or_else(|| io::Error::other("NXDOMAIN")) })
        }))
    }

    #[tokio::test]
    async fn resolver_refuses_a_name_with_any_private_answer() {
        let resolver = fake_dns(&[
            ("rebind.test", &["93.184.216.34", "169.254.170.2"]),
            ("v6.test", &["fd00:ec2::254"]),
            ("mapped.test", &["::ffff:10.0.0.1"]),
        ]);
        for name in ["rebind.test", "v6.test", "mapped.test"] {
            let Err(error) = resolver.resolve(Name::from_str(name).unwrap()).await else {
                panic!("{name} should be refused");
            };
            assert!(is_blocked_address(error.as_ref()), "{name}: {error}");
        }
    }

    #[tokio::test]
    async fn resolver_passes_every_public_answer() {
        let resolver = fake_dns(&[("public.test", &["93.184.216.34", "2606:2800:220:1::1"])]);
        let addrs: Vec<SocketAddr> = match resolver
            .resolve(Name::from_str("public.test").unwrap())
            .await
        {
            Ok(addrs) => addrs.collect(),
            Err(error) => panic!("public.test refused: {error}"),
        };
        assert_eq!(addrs.len(), 2);
    }

    #[test]
    fn literal_hosts_face_the_same_rules() {
        let blocked = |raw: &str| blocked_literal_host(&url::Url::parse(raw).unwrap()).is_some();
        assert!(blocked("http://169.254.169.254/latest"));
        assert!(blocked("http://127.0.0.1:8123/"));
        assert!(blocked("http://[::ffff:10.0.0.1]/"));
        assert!(blocked("http://[fe80::1]/"));
        assert!(!blocked("https://8.8.8.8:8443/"));
        assert!(!blocked("https://clickhouse.example.com/"));
    }

    /// A raw HTTP server on loopback: counts connections, answers each with `respond`.
    async fn serve_raw(respond: fn(tokio::net::TcpStream) -> Serve) -> (u16, Arc<AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&hits);
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                counter.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(respond(stream));
            }
        });
        (port, hits)
    }

    async fn read_request(stream: &mut tokio::net::TcpStream) {
        let mut buf = [0u8; 4096];
        drop(stream.read(&mut buf).await);
    }

    fn ok_reply(mut stream: tokio::net::TcpStream) -> Serve {
        Box::pin(async move {
            read_request(&mut stream).await;
            let body = "Code: 60. DB::Exception: UNKNOWN_TABLE";
            let reply = format!(
                "HTTP/1.1 404 Not Found\r\ncontent-length: {}\r\n\r\n{body}",
                body.len()
            );
            drop(stream.write_all(reply.as_bytes()).await);
        })
    }

    #[tokio::test]
    async fn opted_in_client_reaches_a_private_name() {
        let (port, hits) = serve_raw(ok_reply).await;
        let response = tenant_client_builder(None)
            .build()
            .unwrap()
            .post(format!("http://localhost:{port}/"))
            .send()
            .await
            .expect("the private-network opt-in dials loopback names");
        assert_eq!(response.status(), 404);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    /// Answers with a chunked body that never ends.
    fn endless_reply(mut stream: tokio::net::TcpStream) -> Serve {
        Box::pin(async move {
            read_request(&mut stream).await;
            let head = b"HTTP/1.1 500 Internal Server Error\r\ntransfer-encoding: chunked\r\n\r\n";
            if stream.write_all(head).await.is_err() {
                return;
            }
            let mut chunk = b"1000\r\n".to_vec();
            chunk.extend(std::iter::repeat_n(b'x', 0x1000));
            chunk.extend_from_slice(b"\r\n");
            while stream.write_all(&chunk).await.is_ok() {}
        })
    }

    #[tokio::test]
    async fn client_refuses_a_name_rebound_to_loopback_without_connecting() {
        let (port, hits) = serve_raw(ok_reply).await;
        let client = tenant_client_builder(Some(fake_dns(&[("rebind.test", &["127.0.0.1"])])))
            .build()
            .unwrap();
        let error = client
            .post(format!("http://rebind.test:{port}/"))
            .send()
            .await
            .expect_err("a loopback answer must not be dialled");
        assert!(is_blocked_address(&error), "{error}");
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn read_body_capped_stops_an_endless_chunked_body_at_the_limit() {
        let (port, _) = serve_raw(endless_reply).await;
        let response = reqwest::get(format!("http://127.0.0.1:{port}/"))
            .await
            .unwrap();
        let body = tokio::time::timeout(
            Duration::from_secs(10),
            read_body_capped(response, 64 * 1024),
        )
        .await
        .expect("an endless body must be cut off, not read to the end");
        assert_eq!(body.len(), 64 * 1024);
    }

    #[tokio::test]
    async fn read_body_capped_reads_a_small_body_in_full() {
        let (port, _) = serve_raw(ok_reply).await;
        let response = reqwest::get(format!("http://127.0.0.1:{port}/"))
            .await
            .unwrap();
        assert_eq!(
            read_body_capped(response, 64 * 1024).await,
            "Code: 60. DB::Exception: UNKNOWN_TABLE"
        );
    }
}
