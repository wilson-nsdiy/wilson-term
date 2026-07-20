// 存储系统
// 对应 src/main/storage.ts
//
// 各类配置以 JSON 文件持久化到 %LOCALAPPDATA%/wilson-terminal/

use std::path::PathBuf;

use serde::{de::DeserializeOwned, Serialize};

use crate::types::{
    AppSettings, CommandButtonGroup, Profile, SavedSession, SavedSessionGroup, ScheduledTask,
    ViewState,
};

/// 存储目录：Windows %LOCALAPPDATA%/wilson-terminal/，其他平台用户目录
pub fn storage_dir() -> PathBuf {
    if cfg!(windows) {
        if let Ok(lad) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(lad).join("wilson-terminal");
        }
    }
    dirs::home_dir().unwrap_or_default().join(".wilson-terminal")
}

fn storage_path(filename: &str) -> PathBuf {
    storage_dir().join(filename)
}

fn read_json<T: DeserializeOwned>(filename: &str, default: T) -> T {
    let path = storage_path(filename);
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return default,
    };
    match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => {
            // JSON 损坏:不再静默返回 default 清空用户历史数据,
            // 而是备份原文件(带时间戳)再返回 default,保留排错线索
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let bak = path.with_extension(format!(
                "json.bak.{}.corrupt",
                ts
            ));
            let _ = std::fs::rename(&path, &bak);
            log::error!(
                "存储文件 {:?} JSON 解析失败: {}, 原文件已备份到 {:?}",
                path, e, bak
            );
            default
        }
    }
}

fn write_json<T: Serialize>(filename: &str, data: &T) -> std::io::Result<()> {
    let path = storage_path(filename);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(data)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    // 原子写:先写临时文件再 rename 替换,
    // 避免进程在写中途崩溃(断电/panic)致文件损坏,用户历史数据丢失
    let tmp = path.with_extension("json.tmp.write");
    std::fs::write(&tmp, json)?;
    // rename 是同卷原子操作;不同卷会 fall back 复制+删除(非原子但优于原)
    if let Err(e) = std::fs::rename(&tmp, &path) {
        // rename 失败(跨卷或权限),回退直接写目标(保留原 bug 风险但继续工作)
        let _ = std::fs::remove_file(&tmp);
        std::fs::write(&path, serde_json::to_string_pretty(data)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?)?;
        return Err(e);
    }
    Ok(())
}

// === 各类存储操作 ===

pub fn load_saved_sessions() -> Vec<SavedSession> {
    read_json("saved-sessions.json", Vec::new())
}

pub fn save_saved_sessions(sessions: &[SavedSession]) -> std::io::Result<()> {
    write_json("saved-sessions.json", &sessions)
}

pub fn load_saved_session_groups() -> Vec<SavedSessionGroup> {
    read_json("saved-session-groups.json", Vec::new())
}

pub fn save_saved_session_groups(groups: &[SavedSessionGroup]) -> std::io::Result<()> {
    write_json("saved-session-groups.json", &groups)
}

pub fn load_command_button_groups() -> Vec<CommandButtonGroup> {
    read_json("command-button-groups.json", Vec::new())
}

pub fn save_command_button_groups(groups: &[CommandButtonGroup]) -> std::io::Result<()> {
    write_json("command-button-groups.json", &groups)
}

pub fn load_app_settings() -> Option<AppSettings> {
    let path = storage_path("app-settings.json");
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn save_app_settings(settings: &AppSettings) -> std::io::Result<()> {
    write_json("app-settings.json", &settings)
}

pub fn load_view_state() -> Option<ViewState> {
    let path = storage_path("view-state.json");
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn save_view_state(state: &ViewState) -> std::io::Result<()> {
    write_json("view-state.json", &state)
}

pub fn load_scheduled_tasks() -> std::collections::HashMap<String, Vec<ScheduledTask>> {
    read_json("scheduled-tasks.json", std::collections::HashMap::new())
}

pub fn save_scheduled_tasks(
    tasks: &std::collections::HashMap<String, Vec<ScheduledTask>>,
) -> std::io::Result<()> {
    write_json("scheduled-tasks.json", &tasks)
}

pub fn load_profiles() -> Vec<Profile> {
    read_json("profiles.json", Vec::new())
}

pub fn save_profiles(profiles: &[Profile]) -> std::io::Result<()> {
    write_json("profiles.json", &profiles)
}

pub fn load_ignored_versions() -> Vec<String> {
    read_json("ignored-versions.json", Vec::new())
}

pub fn save_ignored_versions(versions: &[String]) -> std::io::Result<()> {
    write_json("ignored-versions.json", &versions)
}

pub fn load_last_auto_check_timestamp() -> Option<u64> {
    let v: serde_json::Value = read_json("last-auto-check.json", serde_json::Value::Null);
    v.get("timestamp").and_then(|t| t.as_u64())
}

pub fn save_last_auto_check_timestamp(ts: u64) -> std::io::Result<()> {
    let v = serde_json::json!({ "timestamp": ts });
    write_json("last-auto-check.json", &v)
}
