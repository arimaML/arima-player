//! Custom window background.
//!
//! A user-picked image is validated by actually decoding it, downscaled to a
//! sane size, re-encoded as JPEG and stored in `app_data_dir()` as
//! `background.jpg`. The frontend receives it as a `data:` URL.
//!
//! The downscale is not cosmetic: the background sits behind several
//! `backdrop-filter: blur()` layers, and a 6000px wallpaper makes that
//! pathologically expensive for the GPU compositor.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::ImageFormat;
use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Longest edge of the stored wallpaper.
const MAX_EDGE: u32 = 2560;
const JPEG_QUALITY: u8 = 85;
const FILE_NAME: &str = "background.jpg";

/// Formats we accept from the user. `image` is built with exactly these.
const ACCEPTED: &[ImageFormat] = &[
    ImageFormat::Jpeg,
    ImageFormat::Png,
    ImageFormat::WebP,
    ImageFormat::Gif,
    ImageFormat::Bmp,
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundInfo {
    /// `data:` URL ready for a CSS `background-image`, `None` when unset.
    pub data_url: Option<String>,
    /// Absolute path of the stored file, `None` when unset.
    pub path: Option<String>,
}

impl BackgroundInfo {
    fn empty() -> Self {
        Self {
            data_url: None,
            path: None,
        }
    }
}

/// Decode, validate and normalise an image into a bounded JPEG.
///
/// Pure on purpose: no filesystem, no Tauri, so it is unit-testable.
fn normalize(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let format = image::guess_format(bytes)
        .map_err(|_| "Файл не похож на изображение".to_owned())?;

    if !ACCEPTED.contains(&format) {
        return Err(format!(
            "Формат {format:?} не поддерживается. Нужен JPEG, PNG, WebP, GIF или BMP"
        ));
    }

    let decoded = image::load_from_memory_with_format(bytes, format)
        .map_err(|err| format!("Не удалось прочитать изображение: {err}"))?;

    // `resize` preserves the aspect ratio and only ever shrinks relative to the
    // bounding box, so small images are left at their native size.
    let longest = decoded.width().max(decoded.height());
    let scaled = if longest > MAX_EDGE {
        decoded.resize(MAX_EDGE, MAX_EDGE, FilterType::Lanczos3)
    } else {
        decoded
    };

    // JPEG has no alpha channel, so flatten first or the encoder rejects RGBA.
    let rgb = scaled.to_rgb8();

    let mut out = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
    encoder
        .encode_image(&rgb)
        .map_err(|err| format!("Не удалось перекодировать изображение: {err}"))?;

    Ok(out)
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Не найти папку данных приложения: {err}"))?;
    Ok(dir.join(FILE_NAME))
}

fn read_info(path: &Path) -> BackgroundInfo {
    let Ok(bytes) = std::fs::read(path) else {
        return BackgroundInfo::empty();
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    BackgroundInfo {
        data_url: Some(format!("data:image/jpeg;base64,{encoded}")),
        path: Some(path.display().to_string()),
    }
}

/// Current background, if one has been set.
#[tauri::command]
pub fn get_background(app: AppHandle) -> Result<BackgroundInfo, String> {
    let path = store_path(&app)?;
    Ok(if path.exists() {
        read_info(&path)
    } else {
        BackgroundInfo::empty()
    })
}

/// Validate, normalise and store a new background, replacing any previous one.
#[tauri::command]
pub fn set_background(app: AppHandle, source: String) -> Result<BackgroundInfo, String> {
    let source = PathBuf::from(source);
    let bytes = std::fs::read(&source).map_err(|err| format!("Не открыть файл: {err}"))?;

    let normalized = normalize(&bytes)?;

    let destination = store_path(&app)?;
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Не создать папку данных: {err}"))?;
    }
    std::fs::write(&destination, &normalized)
        .map_err(|err| format!("Не сохранить фон: {err}"))?;

    println!(
        "[arima] background stored: {} ({} KB)",
        destination.display(),
        normalized.len() / 1024
    );

    Ok(read_info(&destination))
}

/// Remove the custom background and fall back to the built-in gradient.
#[tauri::command]
pub fn reset_background(app: AppHandle) -> Result<(), String> {
    let path = store_path(&app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|err| format!("Не удалить фон: {err}"))?;
        println!("[arima] background cleared");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let image = RgbImage::from_fn(width, height, |x, y| {
            Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn rejects_non_images() {
        let err = normalize(b"this is definitely not an image").unwrap_err();
        assert!(err.contains("не похож"), "unexpected error: {err}");
    }

    #[test]
    fn downscales_a_huge_wallpaper_to_the_cap() {
        // 6000px wide: exactly the case that would wreck the compositor.
        let out = normalize(&png_bytes(6000, 1000)).expect("normalize");
        let decoded = image::load_from_memory_with_format(&out, ImageFormat::Jpeg).unwrap();

        assert_eq!(decoded.width().max(decoded.height()), MAX_EDGE);
        // Aspect ratio preserved: 6000x1000 -> 2560x427 (rounded).
        assert!(decoded.height() < 500, "got height {}", decoded.height());
    }

    #[test]
    fn leaves_small_images_at_their_native_size() {
        let out = normalize(&png_bytes(800, 600)).expect("normalize");
        let decoded = image::load_from_memory_with_format(&out, ImageFormat::Jpeg).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (800, 600));
    }

    #[test]
    fn output_is_always_jpeg() {
        let out = normalize(&png_bytes(1200, 900)).expect("normalize");
        assert_eq!(image::guess_format(&out).unwrap(), ImageFormat::Jpeg);
    }
}
