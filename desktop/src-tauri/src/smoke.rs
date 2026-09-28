//! Integration harness, compiled only with the explicit smoke-test feature.
use std::{env, fs, path::PathBuf};
pub fn output_dir() -> PathBuf {
    PathBuf::from(env::var_os("REALPIXELART_SMOKE_DIR").expect("smoke output directory"))
}
pub fn script() -> String {
    let cases = fs::read_to_string(output_dir().join("input.json")).expect("smoke inputs");
    format!(
        "window.__SMOKE_CASES__={cases};window.__SMOKE_STARTED__={};\n{}",
        env::var("REALPIXELART_SMOKE_STARTED")
            .expect("smoke start time")
            .parse::<u64>()
            .expect("numeric start time"),
        fs::read_to_string(output_dir().join("runtime.js")).expect("smoke script")
    )
}
#[tauri::command]
pub fn finish_smoke(app: tauri::AppHandle, report: serde_json::Value) -> Result<(), String> {
    fs::write(
        output_dir().join("report.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .map_err(|error| error.to_string())?;
    app.exit(if report["ok"] == true { 0 } else { 1 });
    Ok(())
}
