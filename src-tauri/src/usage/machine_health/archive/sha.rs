//! SHA-256 that can stop at a 64-byte boundary and carry on later, so a
//! version's whole hash stays current as it grows without reading it again
//! from the start. The saved midstate is the eight words and how many blocks
//! went into them; the bytes after the last whole block come from the file.

use sha2::digest::generic_array::{typenum::U64, GenericArray};

const H0: [u32; 8] = [0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f, 0x9b05_688c, 0x1f83_d9ab, 0x5be0_cd19];

/// The hash of every whole block so far.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Midstate {
    state: [u32; 8],
    blocks: u64,
}

impl Midstate {
    pub(crate) const LEN: usize = 40;

    /// How many bytes it covers.
    pub(crate) fn len(&self) -> u64 {
        self.blocks * 64
    }

    pub(crate) fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(Self::LEN);
        for word in self.state {
            out.extend_from_slice(&word.to_be_bytes());
        }
        out.extend_from_slice(&self.blocks.to_be_bytes());
        out
    }

    pub(crate) fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != Self::LEN {
            return None;
        }
        let mut state = [0u32; 8];
        for (word, raw) in state.iter_mut().zip(bytes.chunks_exact(4)) {
            *word = u32::from_be_bytes(raw.try_into().ok()?);
        }
        Some(Self { state, blocks: u64::from_be_bytes(bytes[32..].try_into().ok()?) })
    }
}

#[derive(Clone)]
pub(crate) struct Sha {
    mid: Midstate,
    buf: [u8; 64],
    buffered: usize,
}

impl Sha {
    pub(crate) fn new() -> Self {
        Self::resume(Midstate { state: H0, blocks: 0 })
    }

    pub(crate) fn resume(mid: Midstate) -> Self {
        Self { mid, buf: [0; 64], buffered: 0 }
    }

    pub(crate) fn len(&self) -> u64 {
        self.mid.len() + self.buffered as u64
    }

    /// The state at the last 64-byte boundary.
    pub(crate) fn midstate(&self) -> Midstate {
        self.mid
    }

    pub(crate) fn update(&mut self, mut data: &[u8]) {
        if self.buffered > 0 {
            let take = (64 - self.buffered).min(data.len());
            self.buf[self.buffered..self.buffered + take].copy_from_slice(&data[..take]);
            self.buffered += take;
            data = &data[take..];
            if self.buffered < 64 {
                return;
            }
            let block = self.buf;
            self.compress(&block);
            self.buffered = 0;
        }
        let whole = data.len() / 64 * 64;
        if whole > 0 {
            let blocks: Vec<GenericArray<u8, U64>> = data[..whole].chunks_exact(64).map(|block| GenericArray::clone_from_slice(block)).collect();
            sha2::compress256(&mut self.mid.state, &blocks);
            self.mid.blocks += blocks.len() as u64;
        }
        let rest = &data[whole..];
        self.buf[..rest.len()].copy_from_slice(rest);
        self.buffered = rest.len();
    }

    fn compress(&mut self, block: &[u8; 64]) {
        sha2::compress256(&mut self.mid.state, &[GenericArray::clone_from_slice(block)]);
        self.mid.blocks += 1;
    }

    pub(crate) fn finish(&self) -> [u8; 32] {
        let mut last = self.clone();
        let bits = self.len() * 8;
        last.update(&[0x80]);
        while last.buffered != 56 {
            last.update(&[0]);
        }
        last.update(&bits.to_be_bytes());
        let mut out = [0u8; 32];
        for (raw, word) in out.chunks_exact_mut(4).zip(last.mid.state) {
            raw.copy_from_slice(&word.to_be_bytes());
        }
        out
    }
}

/// The ordinary hash of `data`.
pub(crate) fn sha256(data: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(data).into()
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

#[cfg(test)]
pub(crate) fn unhex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len()).step_by(2).map(|at| u8::from_str_radix(text.get(at..at + 2)?, 16).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::super::chunker::tests::Rng;
    use super::*;

    #[test]
    fn matches_the_ordinary_hash_however_it_is_fed() {
        let mut rng = Rng(7);
        for len in [0usize, 1, 55, 56, 63, 64, 65, 119, 128, 1000, 4097] {
            let data: Vec<u8> = (0..len).map(|_| rng.next() as u8).collect();
            let mut sha = Sha::new();
            let mut rest = &data[..];
            while !rest.is_empty() {
                let n = 1 + rng.below(rest.len().min(200));
                sha.update(&rest[..n]);
                rest = &rest[n..];
            }
            assert_eq!(sha.finish(), sha256(&data), "{len}");
            assert_eq!(sha.len(), len as u64);
        }
    }

    #[test]
    fn carries_on_from_a_saved_midstate() {
        let mut rng = Rng(11);
        let data: Vec<u8> = (0..3000).map(|_| rng.next() as u8).collect();
        for stop in [0usize, 10, 64, 700, 2999] {
            let mut first = Sha::new();
            first.update(&data[..stop]);
            let saved = Midstate::decode(&first.midstate().encode()).unwrap();
            assert_eq!(saved.len(), (stop / 64 * 64) as u64);
            let mut later = Sha::resume(saved);
            later.update(&data[saved.len() as usize..]);
            assert_eq!(later.finish(), sha256(&data), "{stop}");
        }
        assert!(Midstate::decode(&[0; 39]).is_none());
        assert_eq!(unhex(&hex(&[0, 1, 0xab, 0xff])).unwrap(), [0, 1, 0xab, 0xff]);
        assert!(unhex("abc").is_none());
    }
}
