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

/// Gunzips a single-member `body` that declares `declared` bytes into a buffer of
/// exactly that size, so the caller can reserve the memory up front. More output
/// than declared is `TooLarge`; a second member or trailing bytes are `Invalid`.
#[expect(
    clippy::disallowed_types,
    reason = "bounded by `declared`, which the caller has checked against its ceiling"
)]
pub fn gunzip_declared(body: &[u8], declared: usize) -> Result<Vec<u8>, GunzipError> {
    let read_limit = u64::try_from(declared)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let mut reader = flate2::bufread::GzDecoder::new(body).take(read_limit);
    let mut decompressed = Vec::with_capacity(declared.saturating_add(1));
    reader
        .read_to_end(&mut decompressed)
        .map_err(GunzipError::Invalid)?;
    if decompressed.len() > declared {
        return Err(GunzipError::TooLarge);
    }
    if !reader.into_inner().into_inner().is_empty() {
        return Err(GunzipError::Invalid(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "data after the first gzip member",
        )));
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
    fn gunzip_declared_takes_one_member_of_exactly_its_size() {
        let body = gzip(&[3; 1000]);
        let out = gunzip_declared(&body, 1000).unwrap();
        assert_eq!(
            (out.len(), out.capacity()),
            (1000, 1001),
            "no buffer growth"
        );
        assert!(matches!(
            gunzip_declared(&body, 999),
            Err(GunzipError::TooLarge)
        ));
        let mut two_members = body.clone();
        two_members.extend(gzip(&[4; 10]));
        assert!(matches!(
            gunzip_declared(&two_members, 1000),
            Err(GunzipError::Invalid(_))
        ));
        let mut trailing = body;
        trailing.extend([0; 8]);
        assert!(matches!(
            gunzip_declared(&trailing, 1000),
            Err(GunzipError::Invalid(_))
        ));
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
