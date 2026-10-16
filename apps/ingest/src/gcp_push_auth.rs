//! Pub/Sub push authentication. A push subscription set up with a service
//! account sends `Authorization: Bearer <ID token>`, signed by Google, naming
//! that account (`email`) and the audience the subscription was given (`aud`).
//! Only someone who may act as the account can make Pub/Sub sign as it, so the
//! token stands in for a secret in the push URL.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ring::signature::{RsaPublicKeyComponents, RSA_PKCS1_2048_8192_SHA256};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use tokio::sync::RwLock;

use crate::telemetry::HttpClient;

const GOOGLE_CERTS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS: [&str; 2] = ["https://accounts.google.com", "accounts.google.com"];
/// Tolerated difference between Google's clock and this host's.
const CLOCK_SKEW_SECS: u64 = 60;
/// Google publishes a signing key well before it uses it, and answers with a
/// `max-age` of several hours. An hour keeps rotation far inside that.
const KEYS_TTL: Duration = Duration::from_hours(1);
/// A token naming a key not in hand fetches the keys again at most this often,
/// so made-up key ids can't turn every push into a fetch.
const REFETCH_INTERVAL: Duration = Duration::from_mins(1);

/// An RSA public key, as the big-endian bytes of its modulus and exponent.
#[derive(Clone, Debug)]
pub struct RsaKey {
    pub n: Vec<u8>,
    pub e: Vec<u8>,
}

/// Google's signing keys by key id.
pub type Keys = HashMap<String, RsaKey>;

/// What a valid token says.
#[derive(Debug, PartialEq, Eq)]
pub struct VerifiedPush {
    /// The service account the subscription signs as.
    pub email: String,
    pub audience: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TokenError {
    /// Signed with a key not among those given.
    UnknownKey,
    /// Never a token to accept: malformed, forged, expired, not Google's.
    Invalid(&'static str),
}

#[derive(Debug)]
pub enum PushAuthError {
    /// The push is refused.
    Invalid(&'static str),
    /// Google's keys could not be fetched: the push is not to blame and is
    /// worth delivering again.
    KeysUnavailable(String),
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    kid: Option<String>,
}

#[derive(Deserialize)]
struct Claims {
    iss: String,
    aud: String,
    exp: u64,
    #[serde(default)]
    iat: u64,
    email: Option<String>,
    #[serde(default)]
    email_verified: bool,
}

#[derive(Deserialize)]
struct Jwk {
    kid: String,
    n: String,
    e: String,
}

#[derive(Deserialize)]
struct JwkSet {
    keys: Vec<Jwk>,
}

fn decode_json<T: DeserializeOwned>(segment: &str) -> Option<T> {
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(segment).ok()?).ok()
}

/// Checks a token's RS256 signature against `keys`, and its claims at
/// `now_secs`. The algorithm is fixed: a token that names another is refused.
pub fn verify_with_keys(
    token: &str,
    keys: &Keys,
    now_secs: u64,
) -> Result<VerifiedPush, TokenError> {
    let invalid = TokenError::Invalid;
    let mut segments = token.split('.');
    let (Some(header), Some(claims), Some(signature), None) = (
        segments.next(),
        segments.next(),
        segments.next(),
        segments.next(),
    ) else {
        return Err(invalid("not a JWT"));
    };
    let parsed: Header = decode_json(header).ok_or(invalid("malformed header"))?;
    if parsed.alg != "RS256" {
        return Err(invalid("unsupported algorithm"));
    }
    let key = parsed
        .kid
        .as_deref()
        .and_then(|kid| keys.get(kid))
        .ok_or(TokenError::UnknownKey)?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| invalid("malformed signature"))?;
    let signed = &token[..header.len() + 1 + claims.len()];
    RsaPublicKeyComponents {
        n: &key.n,
        e: &key.e,
    }
    .verify(&RSA_PKCS1_2048_8192_SHA256, signed.as_bytes(), &signature)
    .map_err(|_| invalid("bad signature"))?;

    let claims: Claims = decode_json(claims).ok_or(invalid("malformed claims"))?;
    if !GOOGLE_ISSUERS.contains(&claims.iss.as_str()) {
        return Err(invalid("not issued by Google"));
    }
    if claims.exp.saturating_add(CLOCK_SKEW_SECS) < now_secs {
        return Err(invalid("expired"));
    }
    if claims.iat > now_secs.saturating_add(CLOCK_SKEW_SECS) {
        return Err(invalid("issued in the future"));
    }
    let email = claims
        .email
        .filter(|_| claims.email_verified)
        .ok_or(invalid("no verified email"))?;
    Ok(VerifiedPush {
        email,
        audience: claims.aud,
    })
}

fn parse_keys(body: &[u8]) -> Result<Keys, String> {
    let set: JwkSet = serde_json::from_slice(body).map_err(|error| error.to_string())?;
    set.keys
        .into_iter()
        .map(|jwk| {
            let n = URL_SAFE_NO_PAD
                .decode(&jwk.n)
                .map_err(|error| error.to_string())?;
            let e = URL_SAFE_NO_PAD
                .decode(&jwk.e)
                .map_err(|error| error.to_string())?;
            Ok((jwk.kid, RsaKey { n, e }))
        })
        .collect()
}

enum Source {
    Google(HttpClient),
    Fixed,
}

struct Cached {
    keys: Arc<Keys>,
    fetched_at: Option<Instant>,
}

/// Verifies push tokens against Google's published keys, fetched on first use
/// and kept for `KEYS_TTL`.
pub struct GooglePushAuth {
    source: Source,
    cached: RwLock<Cached>,
}

impl std::fmt::Debug for GooglePushAuth {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GooglePushAuth")
            .finish_non_exhaustive()
    }
}

impl GooglePushAuth {
    pub fn new(client: impl Into<HttpClient>) -> Self {
        Self {
            source: Source::Google(client.into()),
            cached: RwLock::new(Cached {
                keys: Arc::new(Keys::new()),
                fetched_at: None,
            }),
        }
    }

    /// Never fetches: for tests and hosts without network access.
    pub fn with_keys(keys: Keys) -> Self {
        Self {
            source: Source::Fixed,
            cached: RwLock::new(Cached {
                keys: Arc::new(keys),
                fetched_at: Some(Instant::now()),
            }),
        }
    }

    pub async fn verify(&self, token: &str, now_secs: u64) -> Result<VerifiedPush, PushAuthError> {
        let keys = self.keys(false).await?;
        let verified = match verify_with_keys(token, &keys, now_secs) {
            // Google may have started signing with a key published since.
            Err(TokenError::UnknownKey) => {
                verify_with_keys(token, &*self.keys(true).await?, now_secs)
            }
            other => other,
        };
        verified.map_err(|error| match error {
            TokenError::UnknownKey => PushAuthError::Invalid("unknown key"),
            TokenError::Invalid(reason) => PushAuthError::Invalid(reason),
        })
    }

    async fn keys(&self, unknown_key: bool) -> Result<Arc<Keys>, PushAuthError> {
        let due = |cached: &Cached| match cached.fetched_at {
            None => true,
            Some(at) => at.elapsed() > KEYS_TTL || (unknown_key && at.elapsed() > REFETCH_INTERVAL),
        };
        {
            let cached = self.cached.read().await;
            if !due(&cached) {
                return Ok(Arc::clone(&cached.keys));
            }
        }
        let Source::Google(client) = &self.source else {
            return Ok(Arc::clone(&self.cached.read().await.keys));
        };
        let mut cached = self.cached.write().await;
        // Another push may have fetched while this one waited for the lock.
        if !due(&cached) {
            return Ok(Arc::clone(&cached.keys));
        }
        match fetch_keys(client).await {
            Ok(keys) => {
                cached.keys = Arc::new(keys);
                cached.fetched_at = Some(Instant::now());
                Ok(Arc::clone(&cached.keys))
            }
            // Keys still in hand keep verifying until a fetch succeeds.
            Err(_) if !cached.keys.is_empty() => Ok(Arc::clone(&cached.keys)),
            Err(error) => Err(PushAuthError::KeysUnavailable(error)),
        }
    }
}

async fn fetch_keys(client: &HttpClient) -> Result<Keys, String> {
    let response = client
        .get(GOOGLE_CERTS_URL)
        .send()
        .await
        .map_err(|error| format!("fetching Google's signing keys failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "fetching Google's signing keys failed: HTTP {}",
            response.status()
        ));
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("reading Google's signing keys failed: {error}"))?;
    parse_keys(&body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{RsaKeyPair, RSA_PKCS1_SHA256};
    use serde_json::json;

    const TEST_KEY: &[u8] = include_bytes!("testdata/gcp-push-test-key.pk8");
    const TEST_KEY_N: &str = include_str!("testdata/gcp-push-test-key.n");
    const NOW: u64 = 1_792_000_000;

    fn keys() -> Keys {
        Keys::from([(
            "key-1".to_owned(),
            RsaKey {
                n: URL_SAFE_NO_PAD.decode(TEST_KEY_N.trim()).unwrap(),
                e: vec![1, 0, 1],
            },
        )])
    }

    fn sign(header: &serde_json::Value, claims: &serde_json::Value) -> String {
        let encode = |value: &serde_json::Value| URL_SAFE_NO_PAD.encode(value.to_string());
        let signed = format!("{}.{}", encode(header), encode(claims));
        let pair = RsaKeyPair::from_pkcs8(TEST_KEY).unwrap();
        let mut signature = vec![0; pair.public().modulus_len()];
        pair.sign(
            &RSA_PKCS1_SHA256,
            &SystemRandom::new(),
            signed.as_bytes(),
            &mut signature,
        )
        .unwrap();
        format!("{signed}.{}", URL_SAFE_NO_PAD.encode(signature))
    }

    fn claims() -> serde_json::Value {
        json!({
            "iss": "https://accounts.google.com",
            "aud": "https://ingest.test/v1/logpush/gcp/c1",
            "exp": NOW + 3600,
            "iat": NOW,
            "email": "maple-push-0a1b@acme.iam.gserviceaccount.com",
            "email_verified": true,
            "sub": "1234",
        })
    }

    fn token(claims: &serde_json::Value) -> String {
        sign(
            &json!({ "alg": "RS256", "kid": "key-1", "typ": "JWT" }),
            claims,
        )
    }

    #[test]
    fn accepts_a_token_google_signed_for_a_verified_account() {
        assert_eq!(
            verify_with_keys(&token(&claims()), &keys(), NOW),
            Ok(VerifiedPush {
                email: "maple-push-0a1b@acme.iam.gserviceaccount.com".to_owned(),
                audience: "https://ingest.test/v1/logpush/gcp/c1".to_owned(),
            })
        );
    }

    #[test]
    fn refuses_tokens_that_are_not_google_signed_current_and_verified() {
        let changed = |key: &str, value: serde_json::Value| {
            let mut claims = claims();
            claims[key] = value;
            verify_with_keys(&token(&claims), &keys(), NOW)
        };
        assert_eq!(
            changed("iss", json!("https://evil.test")),
            Err(TokenError::Invalid("not issued by Google"))
        );
        assert_eq!(
            changed("exp", json!(NOW - 61)),
            Err(TokenError::Invalid("expired"))
        );
        assert_eq!(
            changed("iat", json!(NOW + 61)),
            Err(TokenError::Invalid("issued in the future"))
        );
        assert_eq!(
            changed("email_verified", json!(false)),
            Err(TokenError::Invalid("no verified email"))
        );
        // Within the tolerated clock difference.
        assert!(changed("exp", json!(NOW - 59)).is_ok());

        // Another account's claims under a genuine signature.
        let valid = token(&claims());
        let segments: Vec<&str> = valid.split('.').collect();
        let mut forged = claims();
        forged["email"] = json!("someone-else@acme.iam.gserviceaccount.com");
        let swapped = format!(
            "{}.{}.{}",
            segments[0],
            URL_SAFE_NO_PAD.encode(forged.to_string()),
            segments[2]
        );
        assert_eq!(
            verify_with_keys(&swapped, &keys(), NOW),
            Err(TokenError::Invalid("bad signature"))
        );

        let none = sign(&json!({ "alg": "none", "kid": "key-1" }), &claims());
        assert_eq!(
            verify_with_keys(&none, &keys(), NOW),
            Err(TokenError::Invalid("unsupported algorithm"))
        );
        let other_key = sign(&json!({ "alg": "RS256", "kid": "key-2" }), &claims());
        assert_eq!(
            verify_with_keys(&other_key, &keys(), NOW),
            Err(TokenError::UnknownKey)
        );
        assert_eq!(
            verify_with_keys("a.b", &keys(), NOW),
            Err(TokenError::Invalid("not a JWT"))
        );
    }

    #[test]
    fn reads_google_jwk_sets() {
        let parsed = parse_keys(
            json!({ "keys": [{ "kid": "abc", "n": TEST_KEY_N.trim(), "e": "AQAB", "kty": "RSA", "alg": "RS256", "use": "sig" }] })
                .to_string()
                .as_bytes(),
        )
        .unwrap();
        assert_eq!(parsed["abc"].e, vec![1, 0, 1]);
        assert!(verify_with_keys(
            &sign(&json!({ "alg": "RS256", "kid": "abc" }), &claims()),
            &parsed,
            NOW
        )
        .is_ok());
    }

    #[tokio::test]
    async fn fixed_keys_verify_without_fetching() {
        let auth = GooglePushAuth::with_keys(keys());
        assert!(auth.verify(&token(&claims()), NOW).await.is_ok());
        let other_key = sign(&json!({ "alg": "RS256", "kid": "key-2" }), &claims());
        assert!(matches!(
            auth.verify(&other_key, NOW).await,
            Err(PushAuthError::Invalid("unknown key"))
        ));
    }
}
