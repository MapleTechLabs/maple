//! The only place request bodies are decompressed. Every reader stops once its
//! output passes a caller-chosen ceiling, so a small body cannot inflate without
//! bound. `clippy.toml` disallows the raw `flate2` decoders everywhere else.

use std::io::Read;

#[derive(Debug)]
pub enum GunzipError {
    /// Not a valid gzip stream (or, for text, not UTF-8).
    Invalid(std::io::Error),
    /// The stream decompressed past the ceiling.
    TooLarge,
}

#[expect(
    clippy::disallowed_types,
    reason = "the one bounded wrapper around the raw decoder"
)]
fn bounded_reader(body: &[u8], max_decoded: usize) -> impl Read + '_ {
    let read_limit = u64::try_from(max_decoded)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    flate2::read::GzDecoder::new(body).take(read_limit)
}

/// Gunzips `body`, failing with `TooLarge` once more than `max_decoded` bytes come out.
pub fn gunzip_bounded(body: &[u8], max_decoded: usize) -> Result<Vec<u8>, GunzipError> {
    let mut decompressed = Vec::new();
    bounded_reader(body, max_decoded)
        .read_to_end(&mut decompressed)
        .map_err(GunzipError::Invalid)?;
    if decompressed.len() > max_decoded {
        return Err(GunzipError::TooLarge);
    }
    Ok(decompressed)
}

/// Decompressed length of `body` without keeping the bytes, under the same ceiling.
pub fn gunzip_len_bounded(body: &[u8], max_decoded: usize) -> Result<u64, GunzipError> {
    let len = std::io::copy(&mut bounded_reader(body, max_decoded), &mut std::io::sink())
        .map_err(GunzipError::Invalid)?;
    if len > u64::try_from(max_decoded).unwrap_or(u64::MAX) {
        return Err(GunzipError::TooLarge);
    }
    Ok(len)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    fn gzip(plain: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(plain).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn both_readers_stop_at_the_ceiling() {
        let body = gzip(&vec![0; 1024]);
        assert_eq!(gunzip_bounded(&body, 1024).unwrap().len(), 1024);
        assert_eq!(gunzip_len_bounded(&body, 1024).unwrap(), 1024);
        assert!(matches!(
            gunzip_bounded(&body, 1023),
            Err(GunzipError::TooLarge)
        ));
        assert!(matches!(
            gunzip_len_bounded(&body, 1023),
            Err(GunzipError::TooLarge)
        ));
        assert!(matches!(
            gunzip_len_bounded(b"nope", 1024),
            Err(GunzipError::Invalid(_))
        ));
    }
}
