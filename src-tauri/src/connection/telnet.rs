// Telnet 连接实现
// 对应 src/main/connection/telnet-connection.ts + telnet-protocol.ts
//
// 基于 tokio TcpStream + 自实现 IAC 协议协商
// 使用 split 拆分读写两端，避免 Arc 不可变借用问题

use std::sync::Arc;

use tokio::io::{ReadHalf, WriteHalf};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

use crate::types::{SessionStatus, TelnetConfig};

use super::protocol_parser::{
    ProtocolEvent, ProtocolParser, IAC, DO, DONT, WILL, WONT, SB, SE,
    OPT_ECHO, OPT_SUPPRESS_GO_AHEAD, OPT_NAWS,
};

/// Telnet 协议封装：维护 IAC 状态机、协商 NAWS
struct TelnetProtocol {
    parser: ProtocolParser,
    cols: u16,
    rows: u16,
}

impl TelnetProtocol {
    fn new(cols: u16, rows: u16) -> Self {
        Self {
            parser: ProtocolParser::new(),
            cols,
            rows,
        }
    }

    fn feed(&mut self, raw: &[u8]) -> (String, Vec<Vec<u8>>) {
        let events = self.parser.feed(raw);
        let mut data = String::new();
        let mut responses: Vec<Vec<u8>> = Vec::new();

        for ev in events {
            match ev {
                ProtocolEvent::Data(s) => data.push_str(&s),
                ProtocolEvent::IacDo(opt) => {
                    if opt == OPT_NAWS || opt == OPT_SUPPRESS_GO_AHEAD {
                        responses.push(vec![IAC, WILL, opt]);
                        if opt == OPT_NAWS {
                            responses.push(self.build_naws());
                        }
                    } else {
                        responses.push(vec![IAC, WONT, opt]);
                    }
                }
                ProtocolEvent::IacDont(_) => {}
                ProtocolEvent::IacWill(opt) => {
                    if opt == OPT_ECHO || opt == OPT_SUPPRESS_GO_AHEAD {
                        responses.push(vec![IAC, DO, opt]);
                    } else {
                        responses.push(vec![IAC, DONT, opt]);
                    }
                }
                ProtocolEvent::IacWont(_) => {}
                ProtocolEvent::IacSb { .. } => {}
            }
        }
        (data, responses)
    }

    fn build_naws(&self) -> Vec<u8> {
        let cols = self.cols;
        let rows = self.rows;
        vec![
            IAC, SB, OPT_NAWS,
            ((cols >> 8) & 0xff) as u8,
            (cols & 0xff) as u8,
            ((rows >> 8) & 0xff) as u8,
            (rows & 0xff) as u8,
            IAC, SE,
        ]
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Vec<u8> {
        self.cols = cols;
        self.rows = rows;
        self.build_naws()
    }
}

/// Telnet 连接
pub struct TelnetConnection {
    session_id: String,
    config: TelnetConfig,
    writer: Arc<Mutex<Option<WriteHalf<TcpStream>>>>,
    protocol: Arc<Mutex<TelnetProtocol>>,
}

impl TelnetConnection {
    pub fn new(session_id: String, config: TelnetConfig) -> Self {
        Self {
            session_id,
            config,
            writer: Arc::new(Mutex::new(None)),
            protocol: Arc::new(Mutex::new(TelnetProtocol::new(80, 24))),
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub async fn connect(
        &self,
        on_data: Box<dyn Fn(String, String) + Send + Sync>,
        on_status: Box<dyn Fn(String, SessionStatus, Option<String>) + Send + Sync>,
    ) -> anyhow::Result<()> {
        let timeout = self.config.timeout.unwrap_or(15000);
        let host = self.config.host.clone();
        let port = self.config.port;

        let socket = tokio::time::timeout(
            std::time::Duration::from_millis(timeout),
            TcpStream::connect((host.as_str(), port)),
        )
        .await
        .map_err(|_| anyhow::anyhow!("连接超时：{}:{}，请检查网络连接或防火墙设置", host, port))??;

        socket.set_nodelay(true)?;

        // 拆分读写两端
        let (read_half, write_half) = tokio::io::split(socket);

        let sid = self.session_id.clone();
        let protocol = self.protocol.clone();
        let on_data = Arc::new(on_data);
        let on_status = Arc::new(on_status);
        // writer 与读取循环共享:用于写回 IAC 协商响应(responses)
        // telnet 协议要求客户端对服务器 DO/WILL 请求回 WILL/WONT/DO/DONT,
        // 否则部分服务器会卡住或行为异常(如不回 WILL NAWS 服务器拿不到终端尺寸)
        let writer_arc = self.writer.clone();

        // 读取循环:独占 read_half
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut reader: ReadHalf<TcpStream> = read_half;
            let mut buf = [0u8; 8192];
            loop {
                // read 错误不再静默吞掉:真错误(连接重置/网络异常)派发给前端,便于排错
                match reader.read(&mut buf).await {
                    Ok(0) => {
                        on_status(sid.clone(), SessionStatus::Disconnected, None);
                        break;
                    }
                    Ok(n) => {
                        let (data, responses) = {
                            let mut guard = protocol.lock().await;
                            guard.feed(&buf[..n])
                        };
                        if !data.is_empty() {
                            on_data(sid.clone(), data);
                        }
                        // 写回 IAC 协商响应(原 bug:responses 被丢弃,协商失败)
                        if !responses.is_empty() {
                            let mut writer_guard = writer_arc.lock().await;
                            if let Some(writer) = writer_guard.as_mut() {
                                for resp in &responses {
                                    let _ = writer.write_all(resp).await;
                                }
                            }
                        }
                    }
                    Err(e) => {
                        on_status(
                            sid.clone(),
                            SessionStatus::Disconnected,
                            Some(format!("读取错误: {}", e)),
                        );
                        break;
                    }
                }
            }
        });

        // 保存 write_half
        {
            let mut guard = self.writer.lock().await;
            *guard = Some(write_half);
        }

        Ok(())
    }

    pub async fn disconnect(&self) -> anyhow::Result<()> {
        let mut guard = self.writer.lock().await;
        *guard = None;
        Ok(())
    }

    pub async fn write(&self, data: &str) -> anyhow::Result<()> {
        use tokio::io::AsyncWriteExt;
        let mut guard = self.writer.lock().await;
        if let Some(writer) = guard.as_mut() {
            let out = data.replace("\r\n", "\r").replace("\r", "\r\n");
            writer.write_all(out.as_bytes()).await?;
        }
        Ok(())
    }

    pub async fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        use tokio::io::AsyncWriteExt;
        let naws = {
            let mut guard = self.protocol.lock().await;
            guard.resize(cols, rows)
        };
        let mut guard = self.writer.lock().await;
        if let Some(writer) = guard.as_mut() {
            writer.write_all(&naws).await?;
        }
        Ok(())
    }
}
