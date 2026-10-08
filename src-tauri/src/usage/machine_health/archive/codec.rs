//! Each stored object is one zstd frame at level 6, carrying its own checksum
//! and its size, so `zstd -dc` alone can read it back and catch damage.
//!
//! Nothing is decompressed without a ceiling. A frame a few kilobytes long can claim gigabytes,
//! and a store or a backup can be handed to Arbor by someone else, so every read stops and
//! fails once it passes what the bytes could honestly hold, instead of filling memory or disk.

use std::io::Read;

const LEVEL: i32 = 6;

/// A stored frame holds one chunk or one growing tail, and linecut-v1 never makes either longer
/// than `chunker::MAX`, so a frame that decompresses past it isn't one Arbor wrote.
const FRAME_MAX: u64 = super::chunker::MAX as u64;

/// A compressed transcript (Codex can keep a rollout as `.jsonl.zst`) is kept as it was found,
/// so only what it decompresses to says how big it is. Real transcripts run to hundreds of
/// megabytes and JSON lines compress around ten to one, rarely past a hundred, so one may
/// decompress to a thousand times its compressed size, never under 64 MB (the most a changed
/// file is read whole at, and the longest line counting reads) and never over 4 GB.
const TRANSCRIPT_RATIO: u64 = 1_000;
const TRANSCRIPT_FLOOR: u64 = 64 << 20;
const TRANSCRIPT_MAX: u64 = 4 << 30;

/// The most a compressed transcript `compressed_len` bytes long is decompressed to.
pub(crate) fn transcript_max(compressed_len: u64) -> u64 {
    compressed_len.saturating_mul(TRANSCRIPT_RATIO).clamp(TRANSCRIPT_FLOOR, TRANSCRIPT_MAX)
}

pub(crate) fn encode(plain: &[u8]) -> Result<Vec<u8>, String> {
    let mut compressor = zstd::bulk::Compressor::new(LEVEL).map_err(|error| format!("Couldn't start zstd: {error}"))?;
    compressor
        .set_parameter(zstd::zstd_safe::CParameter::ChecksumFlag(true))
        .and_then(|()| compressor.set_parameter(zstd::zstd_safe::CParameter::ContentSizeFlag(true)))
        .map_err(|error| format!("Couldn't set up zstd: {error}"))?;
    compressor.compress(plain).map_err(|error| format!("Couldn't compress: {error}"))
}

/// A stored frame: a chunk or a growing tail.
pub(crate) fn decode(frame: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    capped(frame, FRAME_MAX)?.read_to_end(&mut out).map_err(|error| format!("Couldn't decompress: {error}"))?;
    Ok(out)
}

/// What a compressed transcript holds, read as a stream that fails past `transcript_max`.
pub(crate) fn transcript(frame: &[u8]) -> Result<impl Read + '_, String> {
    capped(frame, transcript_max(frame.len() as u64))
}

fn capped(frame: &[u8], max: u64) -> Result<Capped<impl Read + '_>, String> {
    let inner = zstd::stream::Decoder::new(frame).map_err(|error| format!("Couldn't decompress: {error}"))?;
    Ok(Capped { inner, left: max, max })
}

/// A decompressing reader that fails once it has given `max` bytes and there's more.
struct Capped<R> {
    inner: R,
    left: u64,
    max: u64,
}

impl<R: Read> Read for Capped<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        // One byte past what's left tells a stream that ends at the ceiling from one that goes on.
        let want = buf.len().min(usize::try_from(self.left.saturating_add(1)).unwrap_or(usize::MAX));
        let read = self.inner.read(&mut buf[..want])?;
        if read as u64 > self.left {
            return Err(std::io::Error::other(format!("it's over {} MB decompressed, more than it could honestly hold", self.max >> 20)));
        }
        self.left -= read as u64;
        Ok(read)
    }
}

/// The start of what a zstd stream holds, at most `limit` bytes of it, for reading the ids at
/// the top of a compressed transcript.
pub(crate) fn decode_head(frame: impl Read, limit: usize) -> Result<Vec<u8>, String> {
    let decoder = zstd::stream::Decoder::new(frame).map_err(|error| format!("Couldn't decompress: {error}"))?;
    let mut out = Vec::new();
    decoder.take(limit as u64).read_to_end(&mut out).map_err(|error| format!("Couldn't decompress: {error}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_catches_damage() {
        let plain = b"{\"type\":\"user\"}\n".repeat(500);
        let frame = encode(&plain).unwrap();
        assert!(frame.len() < plain.len() / 10);
        assert_eq!(decode(&frame).unwrap(), plain);
        assert_eq!(decode(&encode(b"").unwrap()).unwrap(), b"");
        assert_eq!(decode_head(&frame[..], 20).unwrap(), &plain[..20]);
        // The frame's own checksum catches a flipped byte.
        let mut damaged = frame.clone();
        let middle = damaged.len() / 2;
        damaged[middle] ^= 0x40;
        assert!(decode(&damaged).map_or(true, |bytes| bytes != plain));
        let last = damaged.len() - 1;
        let mut tail_damaged = frame.clone();
        tail_damaged[last] ^= 1;
        assert!(decode(&tail_damaged).is_err());
    }

    #[test]
    fn nothing_decompresses_past_what_it_could_hold() {
        // A stored frame holds at most one chunk: exactly that much is fine, a byte more isn't.
        let full = vec![b'x'; FRAME_MAX as usize];
        assert_eq!(decode(&encode(&full).unwrap()).unwrap().len(), full.len());
        let over = encode(&vec![b'x'; FRAME_MAX as usize + 1]).unwrap();
        assert!(over.len() < 4096);
        let error = decode(&over).unwrap_err();
        assert!(error.contains("8 MB decompressed"), "{error}");

        // A compressed transcript gets room for any real one, and a ceiling.
        assert_eq!(transcript_max(1), TRANSCRIPT_FLOOR);
        assert_eq!(transcript_max(1 << 20), 1_000 << 20);
        assert_eq!(transcript_max(u64::MAX), TRANSCRIPT_MAX);
        let text = b"{\"type\":\"response_item\",\"payload\":{\"n\":1}}\n".repeat(20_000);
        let frame = encode(&text).unwrap();
        let mut plain = Vec::new();
        transcript(&frame).unwrap().read_to_end(&mut plain).unwrap();
        assert_eq!(plain, text);
        // A few kilobytes that claim more than 64 MB stop there, a piece at a time.
        let bomb = encode(&vec![b'\n'; (TRANSCRIPT_FLOOR + 1) as usize]).unwrap();
        assert!(transcript_max(bomb.len() as u64) == TRANSCRIPT_FLOOR, "{}", bomb.len());
        let mut reader = transcript(&bomb).unwrap();
        let mut piece = vec![0u8; 1 << 20];
        let mut total = 0u64;
        let error = loop {
            match reader.read(&mut piece) {
                Ok(0) => panic!("read to the end"),
                Ok(read) => total += read as u64,
                Err(error) => break error,
            }
        };
        assert!(total <= TRANSCRIPT_FLOOR && total + piece.len() as u64 > TRANSCRIPT_FLOOR, "{total}");
        assert!(error.to_string().contains("64 MB decompressed"), "{error}");
    }
}
