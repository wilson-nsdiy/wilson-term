// 插件宿主系统
// 对应 src/main/plugin-host.ts
//
// 插件以 ZIP 包导入，解压到 {userData}/plugins/{id}/
// 主进程插件通过 IPC handler 注册；渲染进程插件通过 new Function() 沙箱加载
// 权限声明控制上下文 API 注入；IPC 通道自动命名空间化（plugin:{id}:*）

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

/// 插件元数据（与 manifest.json 对应）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(default)]
    pub main: Option<String>,
    #[serde(default)]
    pub renderer: Option<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
}

/// 注册表条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRegistryEntry {
    pub id: String,
    pub enabled: bool,
    pub installed_at: i64,
    pub updated_at: i64,
}

/// 声明式状态栏项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStatusBarItem {
    pub plugin_id: Option<String>,
    pub label: String,
    #[serde(default)]
    pub style: Option<PluginStyle>,
    #[serde(default)]
    pub tooltip: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginStyle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border: Option<String>,
}

/// 列表项（渲染进程用）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginListItem {
    pub manifest: PluginManifest,
    pub enabled: bool,
}

/// 导入/导出结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginImportResult {
    pub success: bool,
    #[serde(default)]
    pub plugin_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginExportResult {
    pub success: bool,
    #[serde(default)]
    pub zip_path: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// 插件目录：{userData}/plugins/
pub fn plugins_dir() -> PathBuf {
    if cfg!(windows) {
        if let Ok(lad) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(lad).join("wilson-terminal").join("plugins");
        }
    }
    dirs::home_dir().unwrap_or_default().join(".wilson-terminal").join("plugins")
}

/// 注册表文件路径：plugins/registry.json
fn registry_path() -> PathBuf {
    plugins_dir().join("registry.json")
}

/// 加载注册表
///
/// JSON 损坏时不再静默返回空 Vec 清空用户插件启用状态,
/// 而是备份原文件(带时间戳)再返回空,保留排错线索。
pub fn load_registry() -> Vec<PluginRegistryEntry> {
    let p = registry_path();
    let content = match fs::read_to_string(&p) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let bak = p.with_extension(format!("json.bak.{}.corrupt", ts));
            let _ = fs::rename(&p, &bak);
            log::error!(
                "插件注册表 {:?} JSON 解析失败: {}, 原文件已备份到 {:?}",
                p, e, bak
            );
            Vec::new()
        }
    }
}

/// 保存注册表
///
/// 原子写:先写临时文件再 rename 替换,避免进程崩溃致文件损坏。
pub fn save_registry(entries: &[PluginRegistryEntry]) -> std::io::Result<()> {
    let dir = plugins_dir();
    fs::create_dir_all(&dir)?;
    let json = serde_json::to_string_pretty(entries)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let path = registry_path();
    let tmp = path.with_extension("json.tmp.write");
    fs::write(&tmp, json)?;
    if let Err(e) = fs::rename(&tmp, &path) {
        // rename 失败(跨卷或权限),回退直接写目标
        let _ = fs::remove_file(&tmp);
        fs::write(
            &path,
            serde_json::to_string_pretty(entries)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?,
        )?;
        return Err(e);
    }
    Ok(())
}

/// 列出已安装插件
pub fn list_plugins() -> Vec<PluginListItem> {
    let registry = load_registry();
    let dir = plugins_dir();
    registry
        .iter()
        .filter_map(|entry| {
            let plugin_dir = dir.join(&entry.id);
            let manifest_path = plugin_dir.join("manifest.json");
            if let Ok(content) = fs::read_to_string(&manifest_path) {
                if let Ok(manifest) = serde_json::from_str::<PluginManifest>(&content) {
                    return Some(PluginListItem {
                        manifest,
                        enabled: entry.enabled,
                    });
                }
            }
            None
        })
        .collect()
}

/// 解压 ZIP 到目标目录
///
/// 含 Zip Slip 防御:解压前校验每个条目规范化路径必须仍在 target_dir 之内,
/// 阻止恶意 ZIP 用 `../../etc/passwd` 之类条目逃逸 target_dir 写到任意位置。
/// (Zip Slip 是经典 ZIP 解压漏洞,影响 node_modulesadm-zip、ZipArchive、unzip 等)
fn unzip_to(zip_path: &Path, target_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("打开 ZIP 失败: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取 ZIP 失败: {}", e))?;
    fs::create_dir_all(target_dir).map_err(|e| format!("创建目录失败: {}", e))?;
    // target_dir 规范化基路径,用于 starts_with 边界校验
    // canonicalize 要求路径存在,上面 create_dir_all 已建,OK
    let base = target_dir
        .canonicalize()
        .map_err(|e| format!("规范化基目录失败: {}", e))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("读取条目失败: {}", e))?;
        let name = entry.name().to_string();
        let out_path = target_dir.join(&name);
        // Zip Slip 阯险防御:规范化后必须仍在 target_dir 之内
        // canonicalize 对不存在路径会失败,先 join 再 canonicalize;
        // 但文件尚未创建,改用 components 拆析:剔除 .. 组件后再 join
        let safe_path = {
            let comps = out_path.components().collect::<Vec<_>>();
            // 检查任何 .. 组件都视作穿越尝试,拒绝
            if comps.iter().any(|c| matches!(c, std::path::Component::ParentDir)) {
                return Err(format!(
                    "Zip Slip 鲱险:条目 '{}' 含父目录引用,拒绝解压",
                    name
                ));
            }
            // 剔除 EMPTY/等,保留所有已规范化组件
            let rebuilt: PathBuf = comps.into_iter().collect();
            // 二次确认:重建后的规范化路径必须以 base 为前缀
            // 因为 parent dir 已剔,理论上不可能逃;但用 canonicalize 做最终防御
            // (此时文件可能不存在,canonicalize 会失败,故仅在能 canonicalize 时做)
            if let Ok(canonical) = rebuilt.canonicalize() {
                if !canonical.starts_with(&base) {
                    return Err(format!(
                        "Zip Slip 鲱险:条目 '{}' 解压路径逃逸目标目录,拒绝",
                        name
                    ));
                }
            }
            rebuilt
        };
        if entry.is_dir() {
            fs::create_dir_all(&safe_path).map_err(|e| format!("创建子目录失败: {}", e))?;
        } else {
            if let Some(parent) = safe_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
            }
            let mut out = fs::File::create(&safe_path).map_err(|e| format!("创建文件失败: {}", e))?;
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(|e| format!("读取内容失败: {}", e))?;
            out.write_all(&buf).map_err(|e| format!("写入文件失败: {}", e))?;
        }
    }
    Ok(())
}

/// 将目录打包为 ZIP
fn zip_dir(source_dir: &Path, zip_path: &Path) -> Result<(), String> {
    let file = fs::File::create(zip_path).map_err(|e| format!("创建 ZIP 文件失败: {}", e))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    let walker = WalkDir::new(source_dir).into_iter().filter_map(|e| e.ok());
    for entry in walker {
        let path = entry.path();
        if path == source_dir {
            continue;
        }
        let rel = path.strip_prefix(source_dir).unwrap();
        if entry.file_type().is_dir() {
            zip.add_directory(rel.to_string_lossy(), options)
                .map_err(|e| format!("写入目录失败: {}", e))?;
        } else {
            zip.start_file(rel.to_string_lossy(), options)
                .map_err(|e| format!("写入文件失败: {}", e))?;
            let mut f = fs::File::open(path).map_err(|e| format!("打开文件失败: {}", e))?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).map_err(|e| format!("读取文件失败: {}", e))?;
            zip.write_all(&buf).map_err(|e| format!("写入 ZIP 失败: {}", e))?;
        }
    }
    zip.finish().map_err(|e| format!("完成 ZIP 失败: {}", e))?;
    Ok(())
}

/// 校验插件 ZIP：必须含 manifest.json，且 manifest.id 合法
fn validate_plugin_zip(zip_path: &Path) -> Result<PluginManifest, String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("打开 ZIP 失败: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取 ZIP 失败: {}", e))?;
    let mut found_manifest = false;
    let mut manifest_content = String::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("读取条目失败: {}", e))?;
        let name = entry.name().to_string();
        if name == "manifest.json" || name.ends_with("/manifest.json") {
            found_manifest = true;
            let mut buf = String::new();
            entry.read_to_string(&mut buf).map_err(|e| format!("读取 manifest 失败: {}", e))?;
            manifest_content = buf;
            break;
        }
    }
    if !found_manifest {
        return Err("ZIP 缺少 manifest.json".into());
    }
    let manifest: PluginManifest = serde_json::from_str(&manifest_content)
        .map_err(|e| format!("解析 manifest 失败: {}", e))?;
    if manifest.id.is_empty() || manifest.id.contains('/') || manifest.id.contains('\\') {
        return Err("插件 id 不合法".into());
    }
    Ok(manifest)
}

/// 导入插件 ZIP
pub fn import_plugin(zip_path: &str) -> PluginImportResult {
    let zip_path = Path::new(zip_path);
    let manifest = match validate_plugin_zip(zip_path) {
        Ok(m) => m,
        Err(e) => {
            return PluginImportResult {
                success: false,
                plugin_id: None,
                error: Some(e),
            }
        }
    };

    let plugin_dir = plugins_dir().join(&manifest.id);
    // 清理已有目录
    let _ = fs::remove_dir_all(&plugin_dir);
    fs::create_dir_all(&plugin_dir).ok();

    if let Err(e) = unzip_to(zip_path, &plugin_dir) {
        let _ = fs::remove_dir_all(&plugin_dir);
        return PluginImportResult {
            success: false,
            plugin_id: None,
            error: Some(e),
        };
    }

    // 更新注册表
    let mut registry = load_registry();
    let now = chrono::Local::now().timestamp_millis();
    if let Some(entry) = registry.iter_mut().find(|e| e.id == manifest.id) {
        entry.updated_at = now;
    } else {
        registry.push(PluginRegistryEntry {
            id: manifest.id.clone(),
            enabled: true,
            installed_at: now,
            updated_at: now,
        });
    }
    let _ = save_registry(&registry);

    PluginImportResult {
        success: true,
        plugin_id: Some(manifest.id),
        error: None,
    }
}

/// 导出插件为 ZIP
pub fn export_plugin(plugin_id: &str) -> PluginExportResult {
    let plugin_dir = plugins_dir().join(plugin_id);
    if !plugin_dir.exists() {
        return PluginExportResult {
            success: false,
            zip_path: None,
            error: Some("插件目录不存在".into()),
        };
    }
    let export_dir = plugins_dir().join("exports");
    let _ = fs::create_dir_all(&export_dir);
    let zip_path = export_dir.join(format!("{}.zip", plugin_id));
    match zip_dir(&plugin_dir, &zip_path) {
        Ok(_) => PluginExportResult {
            success: true,
            zip_path: Some(zip_path.to_string_lossy().into_owned()),
            error: None,
        },
        Err(e) => PluginExportResult {
            success: false,
            zip_path: None,
            error: Some(e),
        },
    }
}

/// 卸载插件
pub fn uninstall_plugin(plugin_id: &str) -> bool {
    let plugin_dir = plugins_dir().join(plugin_id);
    let removed = fs::remove_dir_all(&plugin_dir).is_ok();
    let mut registry = load_registry();
    registry.retain(|e| e.id != plugin_id);
    let _ = save_registry(&registry);
    removed
}

/// 启用/禁用插件
pub fn toggle_plugin(plugin_id: &str, enabled: bool) -> bool {
    let mut registry = load_registry();
    if let Some(entry) = registry.iter_mut().find(|e| e.id == plugin_id) {
        entry.enabled = enabled;
        entry.updated_at = chrono::Local::now().timestamp_millis();
        let _ = save_registry(&registry);
        return true;
    }
    false
}

/// 获取插件的渲染进程代码
pub fn get_renderer_code(plugin_id: &str) -> Option<String> {
    let plugin_dir = plugins_dir().join(plugin_id);
    let manifest_path = plugin_dir.join("manifest.json");
    let content = fs::read_to_string(&manifest_path).ok()?;
    let manifest: PluginManifest = serde_json::from_str(&content).ok()?;
    if let Some(renderer_file) = manifest.renderer {
        let renderer_path = plugin_dir.join(&renderer_file);
        fs::read_to_string(&renderer_path).ok()
    } else {
        None
    }
}

/// 全局事件派发用 AppHandle
static GLOBAL_APP: Lazy<StdMutex<Option<tauri::AppHandle>>> = Lazy::new(|| StdMutex::new(None));

pub fn set_global_app(app: tauri::AppHandle) {
    *GLOBAL_APP.lock().unwrap() = Some(app);
}

/// 渲染进程插件 IPC 命名空间：plugin:{id}:{channel}
pub fn namespaced_channel(plugin_id: &str, channel: &str) -> String {
    format!("plugin:{}:{}", plugin_id, channel)
}
