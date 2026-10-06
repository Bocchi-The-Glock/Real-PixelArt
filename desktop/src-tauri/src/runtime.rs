//! Check the system engine before creating a window, including portable builds.
use serde::Serialize;

#[cfg(any(windows, not(feature = "smoke-test")))]
pub const WEBVIEW2_HELP: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";
#[cfg(not(feature = "smoke-test"))]
pub const MACOS_HELP: &str = "https://support.apple.com/108382";
#[cfg(windows)]
pub const MIN_WEBVIEW2_MAJOR: u32 = 110;

#[derive(Debug, Serialize)]
pub struct RuntimeStatus {
    pub available: bool,
    pub version: Option<String>,
    pub message: String,
}

#[cfg(any(windows, test))]
pub fn supported_version(version: &str, minimum: u32) -> bool {
    version
        .split('.')
        .next()
        .and_then(|part| part.parse::<u32>().ok())
        .is_some_and(|major| major >= minimum)
}

pub fn check() -> RuntimeStatus {
    let version = tauri::webview_version().ok();
    #[cfg(windows)]
    let available = version
        .as_deref()
        .is_some_and(|value| supported_version(value, MIN_WEBVIEW2_MAJOR));
    #[cfg(not(windows))]
    let available = version.is_some();
    RuntimeStatus {
        available,
        version,
        message: if available {
            "System WebView is available.".into()
        } else {
            "A supported system WebView is missing. / 缺少可用的系统网页运行环境。".into()
        },
    }
}

#[cfg(windows)]
pub fn offer_installation() {
    use windows_sys::Win32::UI::{
        Shell::ShellExecuteW,
        WindowsAndMessaging::{MessageBoxW, IDYES, MB_ICONWARNING, MB_YESNO, SW_SHOWNORMAL},
    };
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let title = wide("RealPixelArt — WebView2");
    let message = wide("需要安装或更新 Microsoft Edge WebView2 Runtime（110 或更新版本）。\n安装后重新打开 RealPixelArt 即可。\n\nMicrosoft Edge WebView2 Runtime 110 or newer is required.\nInstall it, then reopen RealPixelArt.\n\n是否打开微软官方下载页面？\nOpen Microsoft's official download page?");
    // This native dialog works even if the WebView itself is absent.
    unsafe {
        if MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_YESNO | MB_ICONWARNING,
        ) == IDYES
        {
            ShellExecuteW(
                std::ptr::null_mut(),
                wide("open").as_ptr(),
                wide(WEBVIEW2_HELP).as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            );
        }
    }
}

#[cfg(target_os = "macos")]
pub fn offer_installation() {
    // A system dialog works even when no WebView can be created.
    let script = "display dialog \"请更新 macOS / Safari 后重新打开 RealPixelArt。\\nUpdate macOS / Safari, then reopen RealPixelArt.\" with title \"RealPixelArt\" buttons {\"Cancel\", \"Open instructions\"} default button 2\nif button returned of result is \"Open instructions\" then open location \"https://support.apple.com/108382\"";
    let _ = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", script])
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_check_rejects_missing_malformed_and_old_versions() {
        for version in ["", "unknown", "109.0.0.0", "-1.0"] {
            assert!(!supported_version(version, 110), "{version}");
        }
        assert!(supported_version("110.0.1587.0", 110));
        assert!(supported_version("153.0.4234.48", 110));
    }
}
