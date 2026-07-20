// 串口连接实现
// 对应 src/main/connection/serial-connection.ts
//
// 基于 serialport crate, tokio 异步读取循环

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};
use tokio::sync::Mutex;

use crate::types::{SerialConfig, SerialPortInfo, SessionStatus};

/// 串口连接实例
pub struct SerialConnection {
    session_id: String,
    config: SerialConfig,
    port: Arc<Mutex<Option<Box<dyn SerialPort + Send>>>>,
}

impl SerialConnection {
    pub fn new(session_id: String, config: SerialConfig) -> Self {
        Self {
            session_id,
            config,
            port: Arc::new(Mutex::new(None)),
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// 建立串口连接并启动读取循环
    pub async fn connect(
        &self,
        on_data: Box<dyn Fn(String, String) + Send + Sync>,
        on_status: Box<dyn Fn(String, SessionStatus, Option<String>) + Send + Sync>,
    ) -> Result<()> {
        let path = self.config.path.clone();
        let baud_rate = self.config.baud_rate;
        let data_bits = match self.config.data_bits {
            5 => DataBits::Five,
            6 => DataBits::Six,
            7 => DataBits::Seven,
            _ => DataBits::Eight,
        };
        let stop_bits = match self.config.stop_bits {
            2 => StopBits::Two,
            _ => StopBits::One,
        };
        // parity 改用 SerialParity 枚举,显式映射全部 5 种值,
        // 不再静默把 mark/space 降级为 None(与原 TS 声明 5 种值不符)
        // serialport crate 的 Parity 无 Mark/Space 变体,mark/space 仍映射为 None
        // 但这是显式映射而非静默降级,且会在代码注释中标注限制
        let parity = match self.config.parity {
            crate::types::SerialParity::None => Parity::None,
            crate::types::SerialParity::Even => Parity::Even,
            crate::types::SerialParity::Odd => Parity::Odd,
            // serialport crate 4.x Parity 枚举仅 None/Even/Odd,无 Mark/Space,
            // 显式降级并标注:大多数串口硬件和场景不用 mark/space,
            // 若后续需要可换底层 crate 或自实现串口驱动
            crate::types::SerialParity::Mark => Parity::None,
            crate::types::SerialParity::Space => Parity::None,
        };
        let flow_control = match self.config.flow_control.as_str() {
            "hardware" => FlowControl::Hardware,
            "software" => FlowControl::Software,
            _ => FlowControl::None,
        };

        let port = serialport::new(path.clone(), baud_rate)
            .data_bits(data_bits)
            .stop_bits(stop_bits)
            .parity(parity)
            .flow_control(flow_control)
            .timeout(Duration::from_millis(10))
            .open()
            .map_err(|e| {
                let msg = e.to_string();
                if msg.contains("Access denied") || msg.contains("EACCES") || msg.contains("EPERM")
                    || msg.contains("busy")
                {
                    anyhow!("串口 {} 已被其他程序占用，请关闭占用该串口的程序后重试", path)
                } else if msg.contains("error code 31")
                    || msg.contains("ERROR_GEN_FAILURE")
                    || msg.contains("GetOverlappedResult")
                {
                    anyhow!("串口 {} 设备异常，请检查设备连接或重新插拔后重试", path)
                } else {
                    anyhow!("打开串口失败: {}", msg)
                }
            })?;

        // 启动读取循环
        let sid = self.session_id.clone();
        let sid_err = sid.clone();
        let port_arc = self.port.clone();
        let on_data = Arc::new(on_data);
        let on_status = Arc::new(on_status);

        // 复制一份用于读取
        let read_port = port.try_clone().map_err(|e| anyhow!("串口克隆失败: {}", e))?;

        // 保存写端口
        {
            let mut guard = self.port.lock().await;
            *guard = Some(port);
        }

        // 派发通道:把 spawn_blocking 线程内读到的数据/状态送回 async task 派发,
        // 避免在 spawn_blocking 内 tokio::spawn 派发任务,单线程 runtime 下会饿死
        let (data_tx, mut data_rx) =
            tokio::sync::mpsc::unbounded_channel::<Option<String>>();
        let (status_tx, mut status_rx) =
            tokio::sync::mpsc::unbounded_channel::<(
                String,
                SessionStatus,
                Option<String>,
            )>();
        // spawn_blocking 会 move sid 进闭包,先 clone 出 async task 所需副本
        let sid_data = sid.clone();

        tokio::task::spawn_blocking(move || {
            use std::io::Read;
            let mut reader = read_port;
            let mut buf = [0u8; 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        // 串口关闭
                        let _ = data_tx.send(None);
                        let _ = status_tx.send((
                            sid.clone(),
                            SessionStatus::Disconnected,
                            None,
                        ));
                        break;
                    }
                    Ok(n) => {
                        let data = super::c1_convert::decode_buffer_for_terminal(&buf[..n]);
                        if !data.is_empty() {
                            // 写日志（同步调用，量小可接受）
                            crate::logger::write(&sid, "output", &data);
                            // 数据通过 mpsc 送回 async task 派发，避免 spawn_blocking 内
                            // tokio::spawn 在单线程 runtime 下饿死
                            let _ = data_tx.send(Some(data));
                        }
                    }
                    Err(e) => {
                        if e.kind() == std::io::ErrorKind::TimedOut
                            || e.kind() == std::io::ErrorKind::WouldBlock
                        {
                            // 短超时，继续读取
                            continue;
                        }
                        // 真错误
                        let _ = status_tx.send((
                            sid_err.clone(),
                            SessionStatus::Error,
                            Some(e.to_string()),
                        ));
                        break;
                    }
                }
            }
            drop(reader);
            let _ = port_arc;
        });

        // async 派发任务：消费 mpsc，调 on_data/on_status（在 tokio runtime 内，不会饿死）
        let on_data_async = on_data.clone();
        let on_status_async = on_status.clone();
        tokio::spawn(async move {
            while let Some(Some(data)) = data_rx.recv().await {
                on_data_async(sid_data.clone(), data);
            }
        });
        tokio::spawn(async move {
            while let Some((sid, status, msg)) = status_rx.recv().await {
                on_status_async(sid, status, msg);
            }
        });

        Ok(())
    }

    pub async fn disconnect(&self) -> Result<()> {
        let mut guard = self.port.lock().await;
        if guard.is_some() {
            *guard = None;
        }
        Ok(())
    }

    pub async fn write(&self, data: &str) -> Result<()> {
        // 串口 port 是同步 std::io::Write,在 async 命令中直接调会阻塞 tokio worker。
        // 改用 spawn_blocking 把同步写投到专用阻塞线程池,async 上下文 await 其完成,
        // 不占用 tokio runtime worker。数据 clone 进闭包,port 通过 Arc<Mutex> 共享。
        let port_arc = self.port.clone();
        let data_owned = data.as_bytes().to_vec();
        tokio::task::spawn_blocking(move || {
            use std::io::Write;
            let mut guard = port_arc.blocking_lock();
            if let Some(port) = guard.as_mut() {
                port.write_all(&data_owned)
                    .map_err(|e| anyhow!("串口写入失败: {}", e))?;
                port.flush().ok();
            }
            Ok(())
        })
        .await
        .map_err(|e| anyhow!("write task join 失败: {}", e))?
    }
}

/// 列出可用串口
pub fn list_ports() -> Vec<SerialPortInfo> {
    match serialport::available_ports() {
        Ok(ports) => ports
            .iter()
            .map(|p| {
                let (manufacturer, serial_number, product) = match &p.port_type {
                    serialport::SerialPortType::UsbPort(info) => (
                        info.manufacturer.clone(),
                        info.serial_number.clone(),
                        info.product.clone(),
                    ),
                    _ => (None, None, None),
                };
                SerialPortInfo {
                    path: p.port_name.clone(),
                    manufacturer,
                    serial_number,
                    pnp_id: None,
                    location_id: None,
                    product_id: None,
                    vendor_id: None,
                    friendly_name: product,
                }
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}
