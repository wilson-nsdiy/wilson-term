// SFTP 文件管理模块
// 对应 src/main/sftp.ts
//
// 基于 russh-sftp 2.3 的 SftpSession
// 复用已建立 SSH 连接的 channel

use anyhow::{anyhow, Result};
use russh_sftp::protocol::FileAttributes;

use crate::connection::manager::get_ssh_connection;
use crate::types::{SftpFileEntry, SftpResult};

/// 取或建立 SFTP 会话(复用,避免每次操作新开 channel)
///
/// 通过 SshConnection::get_or_create_sftp 懒初始化:首命令建立 SftpSession
/// 并存进连接实例,后续命令复用同一会话。避免反复新建/销毁 channel 致
/// SSH 服务器限流甚至拒连,且 SftpSession 用完未显式关闭致 channel 泄漏。
/// 返回 Arc<SftpSession>(russh-sftp 2.3 SftpSession 不 Clone)
async fn get_sftp(session_id: &str) -> Result<std::sync::Arc<russh_sftp::client::SftpSession>> {
    let conn = get_ssh_connection(session_id)
        .ok_or_else(|| anyhow!("SSH 连接不存在或已断开"))?;
    conn.get_or_create_sftp().await
}

/// 列出远程目录内容
pub async fn list(session_id: &str, remote_path: &str) -> Result<Vec<SftpFileEntry>> {
    let sftp = get_sftp(session_id).await?;
    let read_dir = sftp
        .read_dir(remote_path)
        .await
        .map_err(|e| anyhow!("读取目录失败: {}", e))?;
    let mut result = Vec::new();
    for entry in read_dir {
        let filename = entry.file_name();
        // 跳过 "." 和 ".."
        if filename == "." || filename == ".." {
            continue;
        }
        let metadata = entry.metadata();
        let longname = format!("{} {}", filename, metadata.size.unwrap_or(0));
        result.push(SftpFileEntry {
            filename,
            longname,
            attrs: convert_file_attributes(&metadata),
        });
    }
    Ok(result)
}

/// 上传文件（本地 → 远程）
///
/// 用 `tokio::io::copy` 流式分块读写,避免把整文件载入 `Vec<u8>` 致 GB 级文件 OOM。
/// 内部缓冲默认 8KB,内存占用恒定。原 bug:`sftp.write(path, &data)` 把整文件载入。
pub async fn upload(
    session_id: &str,
    local_path: &str,
    remote_path: &str,
) -> Result<SftpResult> {
    let sftp = match get_sftp(session_id).await {
        Ok(s) => s,
        Err(e) => return Ok(SftpResult { success: false, error: Some(e.to_string()) }),
    };
    // 本地文件用 tokio AsyncFile 分块读,避免 std::fs::read 整载
    let mut local = match tokio::fs::File::open(local_path).await {
        Ok(f) => f,
        Err(e) => {
            return Ok(SftpResult {
                success: false,
                error: Some(format!("读取本地文件失败: {}", e)),
            })
        }
    };
    // 远程文件用 create 拿 File(AsyncWrite),分块写
    let mut remote = match sftp.create(remote_path).await {
        Ok(f) => f,
        Err(e) => {
            return Ok(SftpResult {
                success: false,
                error: Some(format!("打开远程文件失败: {}", e)),
            })
        }
    };
    // 流式 copy:tokio::io::copy 内部循环 read→write,8KB 缓冲
    match tokio::io::copy(&mut local, &mut remote).await {
        Ok(_) => {
            // 显式 close 刷出远程写入
            use tokio::io::AsyncWriteExt;
            let _ = remote.shutdown().await;
            Ok(SftpResult { success: true, error: None })
        }
        Err(e) => Ok(SftpResult {
            success: false,
            error: Some(format!("上传文件失败: {}", e)),
        }),
    }
}

/// 下载文件（远程 → 本地）
///
/// 用 `tokio::io::copy` 流式分块读写,避免把整文件载入 `Vec<u8>` 致 GB 级文件 OOM。
/// 原 bug:`sftp.read(path)` 返回 `Vec<u8>` 整载。
pub async fn download(
    session_id: &str,
    remote_path: &str,
    local_path: &str,
) -> Result<SftpResult> {
    // 确保本地目录存在
    if let Some(parent) = std::path::Path::new(local_path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let sftp = match get_sftp(session_id).await {
        Ok(s) => s,
        Err(e) => return Ok(SftpResult { success: false, error: Some(e.to_string()) }),
    };
    // 远程文件用 open 拿 File(AsyncRead),分块读
    let mut remote = match sftp.open(remote_path).await {
        Ok(f) => f,
        Err(e) => {
            return Ok(SftpResult {
                success: false,
                error: Some(format!("打开远程文件失败: {}", e)),
            })
        }
    };
    // 本地文件用 tokio AsyncFile 分块写
    let mut local = match tokio::fs::File::create(local_path).await {
        Ok(f) => f,
        Err(e) => {
            return Ok(SftpResult {
                success: false,
                error: Some(format!("创建本地文件失败: {}", e)),
            })
        }
    };
    // 流式 copy:tokio::io::copy 内部循环 read→write,8KB 缓冲
    match tokio::io::copy(&mut remote, &mut local).await {
        Ok(_) => {
            // 刷出本地写入
            use tokio::io::AsyncWriteExt;
            let _ = local.flush().await;
            let _ = local.shutdown().await;
            Ok(SftpResult { success: true, error: None })
        }
        Err(e) => Ok(SftpResult {
            success: false,
            error: Some(format!("下载文件失败: {}", e)),
        }),
    }
}

/// 删除远程文件/目录
pub async fn delete(
    session_id: &str,
    remote_path: &str,
    is_dir: bool,
) -> Result<SftpResult> {
    let sftp = match get_sftp(session_id).await {
        Ok(s) => s,
        Err(e) => return Ok(SftpResult { success: false, error: Some(e.to_string()) }),
    };
    let result = if is_dir {
        sftp.remove_dir(remote_path).await
    } else {
        sftp.remove_file(remote_path).await
    };
    match result {
        Ok(_) => Ok(SftpResult { success: true, error: None }),
        Err(e) => Ok(SftpResult {
            success: false,
            error: Some(if is_dir {
                format!("删除目录失败: {}", e)
            } else {
                format!("删除文件失败: {}", e)
            }),
        }),
    }
}

/// 创建远程目录
pub async fn mkdir(session_id: &str, remote_path: &str) -> Result<SftpResult> {
    let sftp = match get_sftp(session_id).await {
        Ok(s) => s,
        Err(e) => return Ok(SftpResult { success: false, error: Some(e.to_string()) }),
    };
    match sftp.create_dir(remote_path).await {
        Ok(_) => Ok(SftpResult { success: true, error: None }),
        Err(e) => Ok(SftpResult { success: false, error: Some(format!("创建目录失败: {}", e)) }),
    }
}

/// 重命名远程文件/目录
pub async fn rename(
    session_id: &str,
    old_path: &str,
    new_path: &str,
) -> Result<SftpResult> {
    let sftp = match get_sftp(session_id).await {
        Ok(s) => s,
        Err(e) => return Ok(SftpResult { success: false, error: Some(e.to_string()) }),
    };
    match sftp.rename(old_path, new_path).await {
        Ok(_) => Ok(SftpResult { success: true, error: None }),
        Err(e) => Ok(SftpResult { success: false, error: Some(format!("重命名失败: {}", e)) }),
    }
}

/// 将 russh-sftp FileAttributes 转为可序列化的 SftpFileEntry.attrs
fn convert_file_attributes(attrs: &FileAttributes) -> crate::types::SftpFileAttrs {
    let size = attrs.size.unwrap_or(0);
    let mode = attrs.permissions.unwrap_or(0);
    let uid = attrs.uid.unwrap_or(0) as u32;
    let gid = attrs.gid.unwrap_or(0) as u32;
    let atime = attrs.atime.unwrap_or(0) as i64;
    let mtime = attrs.mtime.unwrap_or(0) as i64;

    // 解析 mode 高位（文件类型）
    let file_type = mode & 0o170000;
    let is_directory = file_type == 0o040000;
    let is_file = file_type == 0o100000;
    let is_symbolic_link = file_type == 0o120000;

    crate::types::SftpFileAttrs {
        size,
        mode,
        uid,
        gid,
        atime,
        mtime,
        is_directory,
        is_file,
        is_symbolic_link,
    }
}
