//! Local library: folder scanning and tag/cover extraction via lofty.
//!
//! Produces [`ScannedTrack`] values, which are what the database layer ingests.
//! Artwork is handed over as raw bytes rather than a data URL: the DB layer
//! downscales it to a small JPEG on disk, so a 60-track import never carries a
//! few megabytes of base64 through IPC or into SQLite.

use std::path::{Path, PathBuf};

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::PictureType;
use lofty::probe::read_from_path;
use lofty::tag::Accessor;
use serde::Serialize;

/// Formats the scanner accepts. Decoding support comes from rodio/symphonia.
pub const AUDIO_EXTENSIONS: &[&str] = &["mp3", "flac", "opus", "wav", "m4a", "aac", "ogg"];

/// What the scanner produces for one file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedTrack {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: i64,
    pub file_path: String,
    pub source: &'static str,
    /// Embedded artwork, raw. Never serialised to the frontend.
    #[serde(skip)]
    pub cover: Option<Vec<u8>>,
}

pub fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .is_some_and(|ext| AUDIO_EXTENSIONS.contains(&ext.as_str()))
}

/// Read one file, falling back to the filename when tags are missing or
/// malformed — an untagged file must still be playable.
pub fn read_track(path: &Path) -> ScannedTrack {
    let path_str = path.display().to_string();
    let fallback_title = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| path_str.clone());

    let mut track = ScannedTrack {
        title: fallback_title,
        artist: String::from("Неизвестный исполнитель"),
        album: String::new(),
        duration_ms: 0,
        file_path: path_str,
        source: "local",
        cover: None,
    };

    let Ok(tagged) = read_from_path(path) else {
        return track;
    };

    track.duration_ms = tagged.properties().duration().as_millis() as i64;

    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    let Some(tag) = tag else {
        return track;
    };

    if let Some(title) = tag.title() {
        let title = title.trim();
        if !title.is_empty() {
            track.title = title.to_owned();
        }
    }
    if let Some(artist) = tag.artist() {
        let artist = artist.trim();
        if !artist.is_empty() {
            track.artist = artist.to_owned();
        }
    }
    if let Some(album) = tag.album() {
        track.album = album.trim().to_owned();
    }

    // Prefer the front cover, but accept any embedded picture.
    let picture = tag
        .get_picture_type(PictureType::CoverFront)
        .or_else(|| tag.pictures().first());

    if let Some(picture) = picture {
        track.cover = Some(picture.data().to_vec());
    }

    track
}

/// Recursively collect every playable file under `root`, sorted by title.
pub fn scan_folder(root: &Path) -> Vec<ScannedTrack> {
    let mut tracks = Vec::new();
    let mut pending: Vec<PathBuf> = vec![root.to_path_buf()];

    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if is_audio_file(&path) {
                tracks.push(read_track(&path));
            }
        }
    }

    tracks.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    tracks
}

/// Read an explicit list of dropped files, skipping anything unplayable.
pub fn read_paths(paths: &[PathBuf]) -> Vec<ScannedTrack> {
    let mut tracks = Vec::new();

    for path in paths {
        if path.is_dir() {
            tracks.extend(scan_folder(path));
        } else if is_audio_file(path) {
            tracks.push(read_track(path));
        }
    }

    tracks
}

#[cfg(test)]
mod tests {
    use super::*;
    use rodio::Source as _;

    /// Write a minimal 16-bit mono PCM WAV. Built by hand so the tests need no
    /// binary fixtures and no encoder.
    fn write_wav(path: &Path, seconds: f32, sample_rate: u32) {
        let frames = (sample_rate as f32 * seconds) as u32;
        let data_len = frames * 2;

        let mut bytes = Vec::with_capacity(44 + data_len as usize);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
        bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM
        bytes.extend_from_slice(&1u16.to_le_bytes()); // mono
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
        bytes.extend_from_slice(&2u16.to_le_bytes()); // block align
        bytes.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());

        for frame in 0..frames {
            let phase =
                frame as f32 / sample_rate as f32 * 440.0 * std::f32::consts::TAU;
            bytes.extend_from_slice(&((phase.sin() * 8000.0) as i16).to_le_bytes());
        }

        std::fs::write(path, bytes).unwrap();
    }

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("arima-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn recognises_supported_extensions() {
        assert!(is_audio_file(Path::new("a.mp3")));
        assert!(is_audio_file(Path::new("a.FLAC")));
        assert!(is_audio_file(Path::new("a.m4a")));
        assert!(!is_audio_file(Path::new("cover.jpg")));
        assert!(!is_audio_file(Path::new("notes.txt")));
    }

    #[test]
    fn scans_nested_folders_and_reads_wav_duration() {
        let dir = scratch_dir("scan");
        let nested = dir.join("album");
        std::fs::create_dir_all(&nested).unwrap();

        write_wav(&dir.join("root.wav"), 1.0, 44_100);
        write_wav(&nested.join("deep.wav"), 2.0, 44_100);
        std::fs::write(dir.join("readme.txt"), "not audio").unwrap();

        let found = scan_folder(&dir);
        assert_eq!(found.len(), 2, "should find both wav files, ignoring the txt");

        // Sorted by title, so "deep" precedes "root".
        let deep = found.iter().find(|t| t.title == "deep").expect("deep.wav");
        let deep_seconds = deep.duration_ms as f64 / 1000.0;
        assert!(
            (deep_seconds - 2.0).abs() < 0.1,
            "lofty should report ~2.0s, got {deep_seconds}"
        );

        let root = found.iter().find(|t| t.title == "root").expect("root.wav");
        let root_seconds = root.duration_ms as f64 / 1000.0;
        assert!((root_seconds - 1.0).abs() < 0.1, "got {root_seconds}");
        assert_eq!(root.source, "local");
        assert_eq!(root.file_path, dir.join("root.wav").display().to_string());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn untagged_file_falls_back_to_its_filename() {
        let dir = scratch_dir("fallback");
        let file = dir.join("Some Track Name.wav");
        write_wav(&file, 0.2, 22_050);

        let track = read_track(&file);
        assert_eq!(track.title, "Some Track Name");
        assert!(!track.artist.is_empty(), "artist should never be blank");
        assert!(track.cover.is_none(), "a wav with no art has no cover");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Full decode smoke test against a real file. Skipped unless
    /// `ARIMA_TEST_AUDIO` points at one, so no binary fixture is committed.
    #[test]
    fn decodes_a_real_file_when_provided() {
        let Ok(path) = std::env::var("ARIMA_TEST_AUDIO") else {
            return;
        };
        let path = PathBuf::from(path);
        if !path.exists() {
            return;
        }

        let file = std::fs::File::open(&path).expect("open fixture");
        let decoder = rodio::Decoder::try_from(file).expect("decode fixture");
        let duration = decoder.total_duration().expect("fixture duration");
        println!("decoded {path:?}: {duration:?}");

        assert!(duration.as_secs_f64() > 0.0, "duration must be positive");

        let track = read_track(&path);
        assert!(!track.title.is_empty());
        println!(
            "tags: title={:?} artist={:?} duration={:.2}s",
            track.title,
            track.artist,
            track.duration_ms as f64 / 1000.0
        );
    }
}
