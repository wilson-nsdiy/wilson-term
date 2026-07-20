// 自动更新模块
// 对应 src/main/updater.ts
//
// 基于 tauri-plugin-updater 2.10:
//   UpdaterExt::updater() -> Result<Updater>
//   Updater::check() -> Result<Option<Update>>
//   Update::download(callback) / install(bytes) / download_and_install()

use std::sync::Mutex as StdMutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

use crate::types::{UpdateStatus, UpdateStatusSnapshot};

/// 全局 AppHandle（事件派发用）
static GLOBAL_APP: Lazy<StdMutex<Option<AppHandle>>> = Lazy::new(|| StdMutex::new(None));

pub fn set_global_app(app: AppHandle) {
    *GLOBAL_APP.lock().unwrap() = Some(app);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogEntry {
    pub version: String,
    pub date: String,
    pub notes: String,
}

/// 派发状态快照事件给前端
fn emit_status(app: &AppHandle, snapshot: UpdateStatusSnapshot) {
    let _ = app.emit("update:status-changed", snapshot);
}

/// 检查更新
pub async fn check_update(app: &AppHandle, force: bool) -> UpdateStatusSnapshot {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            return UpdateStatusSnapshot {
                status: UpdateStatus::Error,
                error: Some(format!("更新器初始化失败: {}", e)),
                info: None,
                progress: None,
                manual: force,
            };
        }
    };

    emit_status(
        app,
        UpdateStatusSnapshot {
            status: UpdateStatus::Checking,
            info: None,
            progress: None,
            error: None,
            manual: force,
        },
    );

    match updater.check().await {
        Ok(Some(update)) => {
            let info = crate::types::UpdateInfoSnapshot {
                version: update.version.clone(),
                release_date: update.date.map(|d| d.to_string()),
                release_notes: update.body.clone(),
            };
            emit_status(
                app,
                UpdateStatusSnapshot {
                    status: UpdateStatus::Available,
                    info: Some(info.clone()),
                    progress: None,
                    error: None,
                    manual: force,
                },
            );
            UpdateStatusSnapshot {
                status: UpdateStatus::Available,
                info: Some(info),
                progress: None,
                error: None,
                manual: force,
            }
        }
        Ok(None) => {
            emit_status(
                app,
                UpdateStatusSnapshot {
                    status: UpdateStatus::NotAvailable,
                    info: None,
                    progress: None,
                    error: None,
                    manual: force,
                },
            );
            UpdateStatusSnapshot {
                status: UpdateStatus::NotAvailable,
                info: None,
                progress: None,
                error: None,
                manual: force,
            }
        }
        Err(e) => {
            let msg = e.to_string();
            emit_status(
                app,
                UpdateStatusSnapshot {
                    status: UpdateStatus::Error,
                    info: None,
                    progress: None,
                    error: Some(msg.clone()),
                    manual: force,
                },
            );
            UpdateStatusSnapshot {
                status: UpdateStatus::Error,
                info: None,
                progress: None,
                error: Some(msg),
                manual: force,
            }
        }
    }
}

/// 下载并安装更新
pub async fn download_and_install(app: &AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("没有可用更新")?;

    emit_status(
        app,
        UpdateStatusSnapshot {
            status: UpdateStatus::Downloading,
            info: None,
            progress: None,
            error: None,
            manual: false,
        },
    );

    // 累计已传输字节,跨闭包调用共享
    // 原 bug:闭包参数 chunk_len 是本块大小而非累计,percent 每块都几乎 0%,进度条永远不动
    let transferred = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));

    update
        .download_and_install(
            {
                let transferred = transferred.clone();
                move |chunk_len, total| {
                    if let Some(app) = GLOBAL_APP.lock().unwrap().as_ref() {
                        let total_u64 = total.unwrap_or(0);
                        // 累加本块到 transferred,fetch_add 返回更新前的值
                        let prev = transferred.fetch_add(
                            chunk_len as u64,
                            std::sync::atomic::Ordering::Relaxed,
                        );
                        let cumulative = prev + chunk_len as u64;
                        let _ = app.emit(
                            "update:status-changed",
                            UpdateStatusSnapshot {
                                status: UpdateStatus::Downloading,
                                info: None,
                                progress: Some(crate::types::UpdateProgressSnapshot {
                                    bytes_per_second: 0,
                                    percent: if total_u64 > 0 {
                                        (cumulative as f64 / total_u64 as f64) * 100.0
                                    } else {
                                        0.0
                                    },
                                    total: total_u64,
                                    transferred: cumulative,
                                }),
                                error: None,
                                manual: false,
                            },
                        );
                    }
                }
            },
            || {
                if let Some(app) = GLOBAL_APP.lock().unwrap().as_ref() {
                    let _ = app.emit(
                        "update:status-changed",
                        UpdateStatusSnapshot {
                            status: UpdateStatus::Downloaded,
                            info: None,
                            progress: None,
                            error: None,
                            manual: false,
                        },
                    );
                }
            },
        )
        .await
        .map_err(|e| format!("下载并安装更新失败: {}", e))?;

    Ok(())
}
