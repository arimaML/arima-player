//! SQLite-backed library.
//!
//! Owns the schema, the migration, the smart-folder queries and the on-disk
//! cover cache. Everything the UI knows about the library comes from here —
//! there is no long-lived in-memory library that could drift from the database.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

use crate::library::ScannedTrack;

/// Covers are cached small. They are shown at 40 px in lists and at 280 px on
/// the disc, and a full-resolution cover per track would add megabytes to the
/// app data directory for no visible gain.
const COVER_MAX_EDGE: u32 = 256;
const COVER_QUALITY: u8 = 80;

const SCHEMA_VERSION: i64 = 1;

/// Hard cap on how many rows a global search may return.
///
/// This is a guard, not paging: the library lives on one machine and the whole
/// list is handed to the UI at once, so a one-letter query must not push the
/// entire table through IPC. Raise it if a real library ever outgrows it.
const SEARCH_LIMIT: u32 = 500;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS tracks (
    id          INTEGER PRIMARY KEY,
    title       TEXT    NOT NULL,
    artist      TEXT    NOT NULL,
    album       TEXT,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    file_path   TEXT    NOT NULL UNIQUE,
    source      TEXT    NOT NULL DEFAULT 'local',
    cover_path  TEXT,
    date_added  INTEGER NOT NULL,
    play_count  INTEGER NOT NULL DEFAULT 0,
    last_played INTEGER,
    is_liked    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tracks_file_path   ON tracks(file_path);
CREATE INDEX IF NOT EXISTS idx_tracks_is_liked    ON tracks(is_liked);
CREATE INDEX IF NOT EXISTS idx_tracks_play_count  ON tracks(play_count);
CREATE INDEX IF NOT EXISTS idx_tracks_last_played ON tracks(last_played);
CREATE INDEX IF NOT EXISTS idx_tracks_date_added  ON tracks(date_added);

CREATE TABLE IF NOT EXISTS playlists (
    id           INTEGER PRIMARY KEY,
    name         TEXT    NOT NULL,
    date_created INTEGER NOT NULL,
    is_smart     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id    INTEGER NOT NULL REFERENCES tracks(id)    ON DELETE CASCADE,
    position    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (playlist_id, track_id)
);

-- Small key/value side table. Only used to remember which folders have been
-- imported, so a restart can refresh them instead of asking for the folder
-- again. Not part of the library model itself.
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

/// A track as the UI sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: i64,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// Seconds, converted from the stored milliseconds.
    pub duration: f64,
    pub path: String,
    pub source: String,
    /// Whether artwork exists; the image itself is fetched per row so a folder
    /// listing never carries megabytes of base64.
    pub has_cover: bool,
    pub date_added: i64,
    pub play_count: i64,
    pub last_played: Option<i64>,
    pub is_liked: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub inserted: usize,
    pub updated: usize,
    pub total: i64,
}

/// The four smart folders.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Folder {
    Liked,
    Frequent,
    Recent,
    All,
}

impl Folder {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "liked" => Some(Self::Liked),
            "frequent" => Some(Self::Frequent),
            "recent" => Some(Self::Recent),
            "all" => Some(Self::All),
            _ => None,
        }
    }

    /// The row filter and cap, exactly as the specification writes them.
    ///
    /// Kept apart from the ordering because the list header may override the
    /// order; the filter and the cap must survive that.
    fn filter(self) -> (&'static str, &'static str) {
        match self {
            Self::Liked => ("WHERE is_liked = 1", ""),
            Self::Frequent => ("WHERE play_count > 0", "LIMIT 200"),
            Self::Recent => ("WHERE last_played IS NOT NULL", "LIMIT 200"),
            Self::All => ("", ""),
        }
    }

    /// What the folder means when the header has not asked for another order.
    /// «Часто слушаю» is ordered by play count and «Недавние» by the last play,
    /// otherwise the names would lie about their contents.
    fn natural_order(self) -> &'static str {
        match self {
            Self::Liked | Self::All => "date_added DESC",
            Self::Frequent => "play_count DESC",
            Self::Recent => "last_played DESC",
        }
    }
}

/// Sort orders the list header can ask for.
///
/// A closed enum on purpose: `order_by` only ever returns one of the literals
/// below, so the value cannot carry SQL even though it arrives from the
/// frontend as a plain string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sort {
    Date,
    Title,
    Artist,
    Duration,
    Plays,
}

impl Sort {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "date" => Some(Self::Date),
            "title" => Some(Self::Title),
            "artist" => Some(Self::Artist),
            "duration" => Some(Self::Duration),
            "plays" => Some(Self::Plays),
            _ => None,
        }
    }

    /// `descending` is only meaningful for the one column the header lets you
    /// flip: date, title, artist and play count each have a single natural
    /// direction.
    fn order_by(self, descending: bool) -> &'static str {
        match self {
            Self::Date => "date_added DESC",
            // NOCASE so "абв" and "АБВ" do not land in separate blocks. Note
            // that SQLite folds ASCII only unless it is built with ICU.
            Self::Title => "title COLLATE NOCASE ASC",
            Self::Artist => "artist COLLATE NOCASE ASC",
            Self::Duration if descending => "duration_ms DESC",
            Self::Duration => "duration_ms ASC",
            Self::Plays => "play_count DESC",
        }
    }
}

const COLUMNS: &str = "id, title, artist, album, duration_ms, file_path, source, \
                       cover_path IS NOT NULL, date_added, play_count, last_played, is_liked";

fn map_track(row: &Row<'_>) -> rusqlite::Result<Track> {
    Ok(Track {
        id: row.get(0)?,
        title: row.get(1)?,
        artist: row.get(2)?,
        album: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
        duration: row.get::<_, i64>(4)? as f64 / 1000.0,
        path: row.get(5)?,
        source: row.get(6)?,
        has_cover: row.get(7)?,
        date_added: row.get(8)?,
        play_count: row.get(9)?,
        last_played: row.get(10)?,
        is_liked: row.get::<_, i64>(11)? != 0,
    })
}

/// On conflict, refresh the metadata but leave user data alone: date_added,
/// play_count, last_played and is_liked must survive a rescan.
const UPSERT: &str = r#"
INSERT INTO tracks (title, artist, album, duration_ms, file_path, source, cover_path, date_added)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
ON CONFLICT(file_path) DO UPDATE SET
    title       = excluded.title,
    artist      = excluded.artist,
    album       = excluded.album,
    duration_ms = excluded.duration_ms,
    source      = excluded.source,
    cover_path  = COALESCE(excluded.cover_path, tracks.cover_path)
"#;

pub struct Library {
    conn: Mutex<Connection>,
    cover_dir: PathBuf,
}

impl Library {
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir)
            .map_err(|err| format!("Не создать папку данных: {err}"))?;

        let cover_dir = data_dir.join("covers");
        std::fs::create_dir_all(&cover_dir)
            .map_err(|err| format!("Не создать папку обложек: {err}"))?;

        let conn = Connection::open(data_dir.join("library.db"))
            .map_err(|err| format!("Не открыть базу: {err}"))?;

        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(|err| format!("Не настроить базу: {err}"))?;

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|err| format!("Не прочитать версию схемы: {err}"))?;

        if version < SCHEMA_VERSION {
            conn.execute_batch(SCHEMA)
                .map_err(|err| format!("Не создать схему: {err}"))?;
            // `PRAGMA` does not take bound parameters; the value is a constant.
            conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))
                .map_err(|err| format!("Не записать версию схемы: {err}"))?;
            println!("[arima] library schema migrated to v{SCHEMA_VERSION}");
        }

        Ok(Self {
            conn: Mutex::new(conn),
            cover_dir,
        })
    }

    /// Where the database lives, for the report and for support.
    pub fn database_path(&self) -> String {
        self.conn
            .lock()
            .ok()
            .and_then(|conn| {
                conn.query_row("PRAGMA database_list", [], |row| {
                    row.get::<_, String>(2)
                })
                .ok()
            })
            .unwrap_or_default()
    }

    pub fn count(&self) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM tracks", [], |row| row.get(0))
            .map_err(|err| err.to_string())
    }

    /// Rows for one smart folder.
    ///
    /// `sort` is `None` for the folder's own order. When the header asks for a
    /// different one, only the `ORDER BY` changes: the `WHERE` and the cap stay,
    /// so «Недавние» still means "recently played" even when it is displayed
    /// alphabetically. Note that on those two folders the cap now applies to the
    /// newly ordered set — the 200 most recently played, sorted by name — which
    /// is the honest reading of "sort this list".
    pub fn folder(
        &self,
        folder: Folder,
        sort: Option<Sort>,
        descending: bool,
    ) -> Result<Vec<Track>, String> {
        let (filter, limit) = folder.filter();
        let order = match sort {
            Some(sort) => sort.order_by(descending),
            None => folder.natural_order(),
        };

        let conn = self.conn.lock().unwrap();
        let sql = format!("SELECT {COLUMNS} FROM tracks {filter} ORDER BY {order} {limit}");
        let mut statement = conn.prepare(&sql).map_err(|err| err.to_string())?;
        let rows = statement
            .query_map([], map_track)
            .map_err(|err| err.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|err| err.to_string())
    }

    /// Global search across the whole library, not just the open folder.
    ///
    /// Ordered like «Все треки»: results are a view onto the same rows, so they
    /// arrive in the order the library already uses.
    pub fn search(&self, query: &str) -> Result<Vec<Track>, String> {
        // An empty query would match every row through `%%`; the UI never sends
        // one, but the command should not be a way to dump the whole table.
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }

        let pattern = like_pattern(query);
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            r#"SELECT {COLUMNS} FROM tracks
               WHERE title  LIKE ?1 ESCAPE '\'
                  OR artist LIKE ?1 ESCAPE '\'
                  OR album  LIKE ?1 ESCAPE '\'
               ORDER BY date_added DESC
               LIMIT {SEARCH_LIMIT}"#
        );

        let mut statement = conn.prepare(&sql).map_err(|err| err.to_string())?;
        let rows = statement
            .query_map(params![pattern], map_track)
            .map_err(|err| err.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|err| err.to_string())
    }

    /// Insert or refresh tracks. Safe to run over the same folder repeatedly:
    /// the UNIQUE index on `file_path` plus the upsert keeps it idempotent.
    pub fn import(&self, tracks: &[ScannedTrack]) -> Result<ImportSummary, String> {
        let mut conn = self.conn.lock().unwrap();
        let transaction = conn
            .transaction()
            .map_err(|err| format!("Не начать транзакцию: {err}"))?;

        let now = unix_now();
        let mut inserted = 0usize;
        let mut updated = 0usize;

        for track in tracks {
            let existing: Option<i64> = transaction
                .query_row(
                    "SELECT id FROM tracks WHERE file_path = ?1",
                    params![track.file_path],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|err| err.to_string())?;

            if existing.is_some() {
                updated += 1;
            } else {
                inserted += 1;
            }

            let cover_path = track
                .cover
                .as_deref()
                .and_then(|bytes| store_cover(&self.cover_dir, &track.file_path, bytes));

            transaction
                .execute(
                    UPSERT,
                    params![
                        track.title,
                        track.artist,
                        track.album,
                        track.duration_ms,
                        track.file_path,
                        track.source,
                        cover_path,
                        now,
                    ],
                )
                .map_err(|err| format!("Не записать трек: {err}"))?;
        }

        // Count inside the same transaction: `self.count()` would try to take
        // the connection lock again, and a std Mutex is not reentrant.
        let total: i64 = transaction
            .query_row("SELECT COUNT(*) FROM tracks", [], |row| row.get(0))
            .map_err(|err| err.to_string())?;

        transaction
            .commit()
            .map_err(|err| format!("Не зафиксировать транзакцию: {err}"))?;

        Ok(ImportSummary {
            inserted,
            updated,
            total,
        })
    }

    /// A track's artwork as a `data:` URL, read on demand.
    pub fn cover(&self, track_id: i64) -> Result<Option<String>, String> {
        let conn = self.conn.lock().unwrap();
        let path: Option<Option<String>> = conn
            .query_row(
                "SELECT cover_path FROM tracks WHERE id = ?1",
                params![track_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| err.to_string())?;

        let Some(Some(path)) = path else {
            return Ok(None);
        };

        let Ok(bytes) = std::fs::read(&path) else {
            return Ok(None);
        };

        use base64::Engine as _;
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(Some(format!("data:image/jpeg;base64,{encoded}")))
    }

    pub fn set_liked(&self, track_id: i64, liked: bool) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let changed = conn
            .execute(
                "UPDATE tracks SET is_liked = ?1 WHERE id = ?2",
                params![liked as i64, track_id],
            )
            .map_err(|err| err.to_string())?;

        if changed == 0 {
            return Err(format!("Трек {track_id} не найден"));
        }
        Ok(())
    }

    /// Counts one play. Clicking the same track five times counts five times —
    /// deliberately not de-duplicated.
    pub fn register_play(&self, track_id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tracks SET play_count = play_count + 1, last_played = ?1 WHERE id = ?2",
            params![unix_now(), track_id],
        )
        .map_err(|err| err.to_string())?;
        Ok(())
    }

    /* ---- remembered folders ------------------------------------------- */

    pub fn remember_folder(&self, path: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let mut folders = read_folders(&conn)?;
        if !folders.iter().any(|existing| existing == path) {
            folders.push(path.to_owned());
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('folders', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![serde_json::to_string(&folders).unwrap_or_else(|_| "[]".into())],
            )
            .map_err(|err| err.to_string())?;
        }
        Ok(())
    }

    pub fn folders(&self) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().unwrap();
        read_folders(&conn)
    }
}

fn read_folders(conn: &Connection) -> Result<Vec<String>, String> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = 'folders'", [], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|err| err.to_string())?;

    Ok(raw
        .and_then(|json| serde_json::from_str::<Vec<String>>(&json).ok())
        .unwrap_or_default())
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// Wrap a query in `%…%` for `LIKE`, neutralising its metacharacters first:
/// a user searching for `100%` means that text, not "anything at all".
///
/// Paired with `ESCAPE '\'` in the statement.
fn like_pattern(query: &str) -> String {
    let mut pattern = String::with_capacity(query.len() + 2);
    pattern.push('%');
    for ch in query.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(ch);
    }
    pattern.push('%');
    pattern
}

/// FNV-1a over the file path — gives a stable, collision-resistant cover name
/// without pulling in a hashing dependency.
fn cover_file_name(file_path: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in file_path.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}.jpg")
}

/// Downscale embedded artwork and write it next to the database.
fn store_cover(dir: &Path, file_path: &str, bytes: &[u8]) -> Option<String> {
    let decoded = image::load_from_memory(bytes).ok()?;
    let scaled = if decoded.width().max(decoded.height()) > COVER_MAX_EDGE {
        decoded.resize(COVER_MAX_EDGE, COVER_MAX_EDGE, FilterType::Lanczos3)
    } else {
        decoded
    };

    // JPEG has no alpha channel, so flatten first.
    let rgb = scaled.to_rgb8();
    let mut encoded = Vec::new();
    JpegEncoder::new_with_quality(&mut encoded, COVER_QUALITY)
        .encode_image(&rgb)
        .ok()?;

    let destination = dir.join(cover_file_name(file_path));
    std::fs::write(&destination, encoded).ok()?;
    Some(destination.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("arima-db-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn scanned(path: &str, title: &str) -> ScannedTrack {
        ScannedTrack {
            title: title.to_owned(),
            artist: "Kolibri".to_owned(),
            album: "Night".to_owned(),
            duration_ms: 222_000,
            file_path: path.to_owned(),
            source: "local",
            cover: None,
        }
    }

    fn seeded(name: &str, tracks: &[ScannedTrack]) -> (Library, PathBuf) {
        let dir = scratch(name);
        let library = Library::open(&dir).expect("open");
        library.import(tracks).expect("import");
        (library, dir)
    }

    #[test]
    fn creates_the_specification_schema() {
        let (library, dir) = seeded("schema", &[]);
        let conn = library.conn.lock().unwrap();

        for table in ["tracks", "playlists", "playlist_tracks"] {
            let found: Option<String> = conn
                .query_row(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![table],
                    |row| row.get(0),
                )
                .optional()
                .unwrap();
            assert_eq!(found.as_deref(), Some(table), "missing table {table}");
        }

        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ---- migration ---- */

    #[test]
    fn importing_the_same_folder_twice_does_not_duplicate() {
        let tracks = vec![
            scanned("/music/a.mp3", "Полночь"),
            scanned("/music/b.mp3", "Стеклянный дождь"),
            scanned("/music/c.mp3", "Северный ветер"),
        ];
        let (library, dir) = seeded("idempotent", &tracks);

        let first = library.import(&tracks).expect("second import");
        assert_eq!(first.inserted, 0, "a rescan must insert nothing new");
        assert_eq!(first.updated, 3);
        assert_eq!(first.total, 3);
        assert_eq!(library.folder(Folder::All, None, false).unwrap().len(), 3);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rescan_updates_metadata_but_preserves_user_data() {
        let track = scanned("/music/a.mp3", "Old Title");
        let (library, dir) = seeded("preserve", std::slice::from_ref(&track));

        let id = library.folder(Folder::All, None, false).unwrap()[0].id;
        library.set_liked(id, true).unwrap();
        library.register_play(id).unwrap();
        library.register_play(id).unwrap();

        // The file was retagged and the rescan sees the new metadata.
        let mut retagged = track.clone();
        retagged.title = "New Title".to_owned();
        retagged.album = "Other Album".to_owned();
        let summary = library.import(&[retagged]).expect("rescan");

        assert_eq!(summary.inserted, 0);
        assert_eq!(summary.updated, 1);

        let after = &library.folder(Folder::All, None, false).unwrap()[0];
        assert_eq!(after.title, "New Title", "metadata should be refreshed");
        assert_eq!(after.album, "Other Album");
        assert_eq!(after.id, id, "the row must be reused, not replaced");
        assert!(after.is_liked, "a rescan must not clear the like");
        assert_eq!(after.play_count, 2, "a rescan must not clear play_count");
        assert!(after.last_played.is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn user_data_survives_closing_and_reopening_the_database() {
        let dir = scratch("reopen");
        let id = {
            let library = Library::open(&dir).expect("open");
            library
                .import(&[scanned("/music/a.mp3", "Полночь")])
                .expect("import");
            let id = library.folder(Folder::All, None, false).unwrap()[0].id;
            library.set_liked(id, true).unwrap();
            library.register_play(id).unwrap();
            id
        };

        // Fresh process would do exactly this.
        let reopened = Library::open(&dir).expect("reopen");
        let tracks = reopened.folder(Folder::All, None, false).unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].id, id);
        assert!(tracks[0].is_liked, "like did not survive a reopen");
        assert_eq!(tracks[0].play_count, 1);
        assert!(tracks[0].last_played.is_some());

        let liked = reopened.folder(Folder::Liked, None, false).unwrap();
        assert_eq!(liked.len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ---- smart folders ---- */

    #[test]
    fn frequent_orders_by_play_count_and_hides_unplayed() {
        let tracks = vec![
            scanned("/m/a.mp3", "A"),
            scanned("/m/b.mp3", "B"),
            scanned("/m/c.mp3", "C"),
        ];
        let (library, dir) = seeded("frequent", &tracks);
        let all = library.folder(Folder::All, None, false).unwrap();
        let id_of = |title: &str| all.iter().find(|t| t.title == title).unwrap().id;

        library.register_play(id_of("B")).unwrap();
        for _ in 0..3 {
            library.register_play(id_of("C")).unwrap();
        }

        let frequent = library.folder(Folder::Frequent, None, false).unwrap();
        assert_eq!(
            frequent.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(),
            vec!["C", "B"],
            "play_count DESC, and the unplayed track must not appear"
        );
        assert_eq!(frequent[0].play_count, 3);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recent_orders_by_last_played_and_hides_never_played() {
        let tracks = vec![scanned("/m/a.mp3", "A"), scanned("/m/b.mp3", "B")];
        let (library, dir) = seeded("recent", &tracks);
        let all = library.folder(Folder::All, None, false).unwrap();
        let id_of = |title: &str| all.iter().find(|t| t.title == title).unwrap().id;

        library.register_play(id_of("A")).unwrap();
        // Force B to be more recent without relying on wall-clock resolution.
        {
            let conn = library.conn.lock().unwrap();
            conn.execute(
                "UPDATE tracks SET last_played = ?1 WHERE id = ?2",
                params![unix_now() + 60, id_of("B")],
            )
            .unwrap();
        }

        let recent = library.folder(Folder::Recent, None, false).unwrap();
        assert_eq!(
            recent.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(),
            vec!["B", "A"]
        );

        // A third, never played track stays out of Recent.
        library.import(&[scanned("/m/c.mp3", "C")]).unwrap();
        let recent = library.folder(Folder::Recent, None, false).unwrap();
        assert!(!recent.iter().any(|t| t.title == "C"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn all_orders_by_date_added_descending() {
        let (library, dir) = seeded("all", &[scanned("/m/a.mp3", "first")]);
        std::thread::sleep(std::time::Duration::from_millis(1100));
        library.import(&[scanned("/m/b.mp3", "second")]).unwrap();

        let all = library.folder(Folder::All, None, false).unwrap();
        assert_eq!(
            all.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(),
            vec!["second", "first"],
            "newest first"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn liking_is_undoable_and_reports_missing_rows() {
        let (library, dir) = seeded("likes", &[scanned("/m/a.mp3", "A")]);
        let id = library.folder(Folder::All, None, false).unwrap()[0].id;

        library.set_liked(id, true).unwrap();
        assert_eq!(library.folder(Folder::Liked, None, false).unwrap().len(), 1);

        library.set_liked(id, false).unwrap();
        assert_eq!(library.folder(Folder::Liked, None, false).unwrap().len(), 0);

        assert!(library.set_liked(9999, true).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn folders_are_remembered_once() {
        let (library, dir) = seeded("folders", &[]);
        library.remember_folder("/music").unwrap();
        library.remember_folder("/music").unwrap();
        library.remember_folder("/other").unwrap();

        assert_eq!(library.folders().unwrap(), vec!["/music", "/other"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_cover_does_not_break_the_import() {
        let mut track = scanned("/m/a.mp3", "A");
        track.cover = Some(b"definitely not an image".to_vec());

        let (library, dir) = seeded("badcover", &[track]);
        let tracks = library.folder(Folder::All, None, false).unwrap();
        assert_eq!(tracks.len(), 1);
        assert!(!tracks[0].has_cover, "a bad cover must degrade, not fail");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ---- global search ---- */

    fn titles(tracks: Vec<Track>) -> Vec<String> {
        tracks.into_iter().map(|track| track.title).collect()
    }

    /// The point of the feature: a hit that is not in the folder on screen.
    #[test]
    fn search_spans_the_whole_library() {
        let tracks = vec![
            scanned("/m/a.mp3", "Полночь"),
            scanned("/m/b.mp3", "Стеклянный дождь"),
            scanned("/m/c.mp3", "Северный ветер"),
        ];
        let (library, dir) = seeded("search-all", &tracks);

        let hits = library.search("Стеклянный").unwrap();
        assert_eq!(titles(hits.clone()), vec!["Стеклянный дождь"]);
        // Nothing about searching may mutate or reorder the library itself.
        assert_eq!(library.folder(Folder::All, None, false).unwrap().len(), 3);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_looks_at_title_artist_and_album() {
        let mut track = scanned("/m/a.mp3", "Полночь");
        track.artist = "Kolibri".to_owned();
        track.album = "Night Drive".to_owned();
        let (library, dir) = seeded("search-fields", &[track]);

        assert_eq!(library.search("Полночь").unwrap().len(), 1, "title");
        assert_eq!(library.search("Kolibri").unwrap().len(), 1, "artist");
        assert_eq!(library.search("Drive").unwrap().len(), 1, "album");
        assert!(library.search("ничего такого").unwrap().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `%` and `_` are `LIKE` metacharacters; a user typing them means the text.
    #[test]
    fn search_treats_like_wildcards_as_text() {
        let tracks = vec![
            scanned("/m/a.mp3", "100% Pure"),
            scanned("/m/b.mp3", "under_score"),
            scanned("/m/c.mp3", "plain"),
        ];
        let (library, dir) = seeded("search-wildcards", &tracks);

        // Unescaped, "%" would match every row and "_" would match any one char.
        assert_eq!(titles(library.search("%").unwrap()), vec!["100% Pure"]);
        assert_eq!(titles(library.search("_").unwrap()), vec!["under_score"]);
        assert_eq!(titles(library.search("100%").unwrap()), vec!["100% Pure"]);
        assert_eq!(titles(library.search("under_score").unwrap()), vec!["under_score"]);

        // A backslash is the escape character itself, so it must survive too.
        assert!(library.search("\\").unwrap().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_search_returns_nothing_instead_of_everything() {
        let (library, dir) = seeded("search-empty", &[scanned("/m/a.mp3", "A")]);

        assert!(library.search("").unwrap().is_empty());
        assert!(library.search("   ").unwrap().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /* ---- sorting ---- */

    #[test]
    fn sorting_by_title_folds_case() {
        let tracks = vec![
            scanned("/m/a.mp3", "banana"),
            scanned("/m/b.mp3", "Apple"),
            scanned("/m/c.mp3", "cherry"),
        ];
        let (library, dir) = seeded("sort-title", &tracks);

        let sorted = library.folder(Folder::All, Some(Sort::Title), false).unwrap();
        assert_eq!(titles(sorted), vec!["Apple", "banana", "cherry"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sorting_by_artist_and_by_plays() {
        let mut a = scanned("/m/a.mp3", "A");
        a.artist = "Yak".to_owned();
        let mut b = scanned("/m/b.mp3", "B");
        b.artist = "albatross".to_owned();
        let mut c = scanned("/m/c.mp3", "C");
        c.artist = "Magpie".to_owned();

        let (library, dir) = seeded("sort-artist", &[a, b, c]);
        let by_artist = library.folder(Folder::All, Some(Sort::Artist), false).unwrap();
        assert_eq!(titles(by_artist), vec!["B", "C", "A"], "artist NOCASE ASC");

        let all = library.folder(Folder::All, None, false).unwrap();
        let id_of = |title: &str| all.iter().find(|t| t.title == title).unwrap().id;
        library.register_play(id_of("A")).unwrap();
        for _ in 0..3 {
            library.register_play(id_of("B")).unwrap();
        }

        let by_plays = library.folder(Folder::All, Some(Sort::Plays), false).unwrap();
        assert_eq!(titles(by_plays), vec!["B", "A", "C"], "play_count DESC");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn duration_sort_flips_direction() {
        let mut a = scanned("/m/a.mp3", "A");
        a.duration_ms = 100_000;
        let mut b = scanned("/m/b.mp3", "B");
        b.duration_ms = 300_000;
        let mut c = scanned("/m/c.mp3", "C");
        c.duration_ms = 200_000;

        let (library, dir) = seeded("sort-duration", &[a, b, c]);

        let ascending = library.folder(Folder::All, Some(Sort::Duration), false).unwrap();
        assert_eq!(titles(ascending), vec!["A", "C", "B"]);

        let descending = library.folder(Folder::All, Some(Sort::Duration), true).unwrap();
        assert_eq!(titles(descending), vec!["B", "C", "A"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Sorting replaces the ORDER BY, never the WHERE: a smart folder must not
    /// start leaking rows it deliberately hides just because the header changed.
    #[test]
    fn an_explicit_sort_keeps_the_smart_folder_filter() {
        let tracks = vec![
            scanned("/m/a.mp3", "Zeta"),
            scanned("/m/b.mp3", "Alpha"),
            scanned("/m/c.mp3", "Mid"),
        ];
        let (library, dir) = seeded("sort-filter", &tracks);
        let all = library.folder(Folder::All, None, false).unwrap();
        let zeta = all.iter().find(|t| t.title == "Zeta").unwrap().id;

        library.register_play(zeta).unwrap();

        let recent = library.folder(Folder::Recent, Some(Sort::Title), false).unwrap();
        assert_eq!(titles(recent), vec!["Zeta"], "never-played rows stay out");

        let liked = library.folder(Folder::Liked, Some(Sort::Title), false).unwrap();
        assert!(liked.is_empty(), "the liked filter survives sorting");

        let frequent = library.folder(Folder::Frequent, Some(Sort::Title), false).unwrap();
        assert_eq!(titles(frequent), vec!["Zeta"], "play_count > 0 survives sorting");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_folder_and_sort_names_are_rejected() {
        assert!(Folder::parse("playlist").is_none());
        assert!(Sort::parse("random").is_none());
        assert_eq!(Sort::parse("duration"), Some(Sort::Duration));

        // A closed enum is what keeps the ORDER BY fragment a constant.
        assert_eq!(Sort::Title.order_by(false), "title COLLATE NOCASE ASC");
    }
}
