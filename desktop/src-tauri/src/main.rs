#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod runtime;
#[cfg(feature = "smoke-test")]
mod smoke;

use std::path::Path;
use tauri::{webview::NewWindowResponse, WebviewUrl, WebviewWindowBuilder};
#[cfg(not(feature = "smoke-test"))]
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

const MAX_EXPORT_BYTES: usize = 128 * 1024 * 1024;

fn export_extension(name: &str, bytes: &[u8]) -> Result<&'static str, String> {
    if name.is_empty() || name.contains(['/', '\\', ':', '\0']) || name == "." || name == ".." {
        return Err("Invalid export filename".into());
    }
    if bytes.len() > MAX_EXPORT_BYTES {
        return Err("Export exceeds 128 MiB".into());
    }
    match Path::new(name).extension().and_then(|value| value.to_str()) {
        Some("png") if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Ok("png"),
        Some("zip") if bytes.starts_with(b"PK\x03\x04") => Ok("zip"),
        _ => Err("Only generated PNG and ZIP files can be saved".into()),
    }
}

#[tauri::command]
async fn save_export(app: tauri::AppHandle, name: String, bytes: Vec<u8>) -> Result<bool, String> {
    #[cfg(not(feature = "smoke-test"))]
    let extension = export_extension(&name, &bytes)?;
    #[cfg(feature = "smoke-test")]
    {
        export_extension(&name, &bytes)?;
        let _ = &app;
    }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(feature = "smoke-test")]
        {
            return std::fs::write(smoke::output_dir().join(&name), bytes)
                .map(|_| true)
                .map_err(|error| error.to_string());
        }
        #[cfg(not(feature = "smoke-test"))]
        {
            let selected = app
                .dialog()
                .file()
                .set_file_name(&name)
                .add_filter(
                    if extension == "png" {
                        "PNG image"
                    } else {
                        "ZIP process details"
                    },
                    &[extension],
                )
                .blocking_save_file();
            let Some(selected) = selected else {
                return Ok(false);
            };
            let destination = selected.into_path().map_err(|error| error.to_string())?;
            std::fs::write(destination, bytes).map_err(|error| error.to_string())?;
            Ok(true)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn runtime_problem(app: tauri::AppHandle, detail: String) -> Result<(), String> {
    #[cfg(feature = "smoke-test")]
    {
        return smoke::finish_smoke(
            app,
            serde_json::json!({
                "ok": false, "error": format!("Missing browser APIs: {detail}")
            }),
        );
    }
    #[cfg(not(feature = "smoke-test"))]
    tauri::async_runtime::spawn_blocking(move || {
        let help = if cfg!(windows) { runtime::WEBVIEW2_HELP } else { runtime::MACOS_HELP };
        let description = format!("系统网页组件缺少此应用需要的功能：\n{detail}\n\n请更新 WebView2（Windows）或 macOS / Safari（Mac）。\nUpdate the system WebView to continue. Open official instructions?");
        if app.dialog().message(description).title("RealPixelArt — Runtime")
            .kind(MessageDialogKind::Warning).buttons(MessageDialogButtons::YesNo).blocking_show() {
            let _ = app.opener().open_url(help, None::<&str>);
        }
    }).await.map_err(|error| error.to_string())
}

fn main() {
    #[cfg(feature = "smoke-test")]
    if std::env::var_os("REALPIXELART_SMOKE_DIR").is_some() {
        let _ = smoke::record_progress("native startup");
    }
    let status = runtime::check();
    if std::env::args().any(|value| value == "--check-runtime") {
        println!(
            "{}",
            serde_json::to_string(&status).expect("serialize runtime status")
        );
        std::process::exit(if status.available { 0 } else { 2 });
    }
    if !status.available {
        runtime::offer_installation();
        return;
    }
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(feature = "smoke-test")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        save_export,
        runtime_problem,
        smoke::smoke_progress,
        smoke::finish_smoke
    ]);
    #[cfg(not(feature = "smoke-test"))]
    let builder = builder.invoke_handler(tauri::generate_handler![save_export, runtime_problem]);
    let result = builder
        .setup(|app| {
            let opener = app.handle().clone();
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("RealPixelArt")
                    .inner_size(1440.0, 1000.0)
                    .min_inner_size(800.0, 600.0)
                    .disable_drag_drop_handler()
                    .on_navigation(|url| {
                        matches!(url.scheme(), "tauri" | "http" | "https")
                            && matches!(url.host_str(), Some("localhost" | "tauri.localhost"))
                    })
                    .on_new_window(move |url, _| {
                        if matches!(url.scheme(), "http" | "https") {
                            let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                        }
                        NewWindowResponse::Deny
                    });
            #[cfg(feature = "smoke-test")]
            // WKWebView can suspend hidden views; exercise a real visible Mac window.
            let window = window
                .visible(cfg!(target_os = "macos"))
                .initialization_script(smoke::script());
            window.build()?;
            Ok(())
        })
        .run(tauri::generate_context!());
    if let Err(error) = result {
        eprintln!("RealPixelArt: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_requires_a_leaf_filename_and_matching_signature() {
        assert_eq!(
            export_extension("像素.png", b"\x89PNG\r\n\x1a\n"),
            Ok("png")
        );
        assert_eq!(export_extension("process.zip", b"PK\x03\x04"), Ok("zip"));
        for name in ["../image.png", "C:\\image.png", "x/y.png", "x.exe", ""] {
            assert!(export_extension(name, b"\x89PNG\r\n\x1a\n").is_err());
        }
        assert!(export_extension("image.png", b"not a png").is_err());
    }
}
