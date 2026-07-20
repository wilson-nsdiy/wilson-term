// Telnet IAC 协议解析器状态机
// 对应 src/main/connection/protocol-parser.ts

// Telnet IAC 常量
pub const IAC: u8 = 255;
pub const DO: u8 = 253;
pub const DONT: u8 = 254;
pub const WILL: u8 = 251;
pub const WONT: u8 = 252;
pub const SB: u8 = 250;
pub const SE: u8 = 240;

// Telnet 选项常量
pub const OPT_ECHO: u8 = 1;
pub const OPT_SUPPRESS_GO_AHEAD: u8 = 3;
pub const OPT_NAWS: u8 = 31;

// 解析器状态
const STATE_DATA: u8 = 0;
const STATE_IAC: u8 = 1;
const STATE_IAC_DO: u8 = 2;
const STATE_IAC_DONT: u8 = 3;
const STATE_IAC_WILL: u8 = 4;
const STATE_IAC_WONT: u8 = 5;
const STATE_IAC_SB: u8 = 6;
const STATE_IAC_SB_DATA: u8 = 7;
const STATE_IAC_SB_IAC: u8 = 8;

/// Telnet IAC 协议事件
#[derive(Debug, Clone)]
pub enum ProtocolEvent {
    /// 干净数据（已剥离 IAC）
    Data(String),
    IacDo(u8),
    IacDont(u8),
    IacWill(u8),
    IacWont(u8),
    /// 子协商：option, data
    IacSb { option: u8, data: Vec<u8> },
}

/// Telnet IAC 状态机解析器
pub struct ProtocolParser {
    state: u8,
    sb_option: u8,
    sb_data: Vec<u8>,
    clean_bytes: Vec<u8>,
}

impl Default for ProtocolParser {
    fn default() -> Self {
        Self::new()
    }
}

impl ProtocolParser {
    pub fn new() -> Self {
        Self {
            state: STATE_DATA,
            sb_option: 0,
            sb_data: Vec::new(),
            clean_bytes: Vec::new(),
        }
    }

    /// 输入原始字节流，返回解析出的事件列表
    pub fn feed(&mut self, raw: &[u8]) -> Vec<ProtocolEvent> {
        let mut events = Vec::new();

        for &byte in raw {
            match self.state {
                STATE_DATA => {
                    if byte == IAC {
                        self.state = STATE_IAC;
                    } else {
                        self.clean_bytes.push(byte);
                    }
                }
                STATE_IAC => {
                    if byte == IAC {
                        // IAC IAC → 透传一个 0xFF
                        self.clean_bytes.push(IAC);
                        self.state = STATE_DATA;
                    } else {
                        match byte {
                            DO => self.state = STATE_IAC_DO,
                            DONT => self.state = STATE_IAC_DONT,
                            WILL => self.state = STATE_IAC_WILL,
                            WONT => self.state = STATE_IAC_WONT,
                            SB => self.state = STATE_IAC_SB,
                            _ => self.state = STATE_DATA,
                        }
                    }
                }
                STATE_IAC_DO => {
                    events.push(ProtocolEvent::IacDo(byte));
                    self.state = STATE_DATA;
                }
                STATE_IAC_DONT => {
                    events.push(ProtocolEvent::IacDont(byte));
                    self.state = STATE_DATA;
                }
                STATE_IAC_WILL => {
                    events.push(ProtocolEvent::IacWill(byte));
                    self.state = STATE_DATA;
                }
                STATE_IAC_WONT => {
                    events.push(ProtocolEvent::IacWont(byte));
                    self.state = STATE_DATA;
                }
                STATE_IAC_SB => {
                    self.sb_option = byte;
                    self.sb_data.clear();
                    self.state = STATE_IAC_SB_DATA;
                }
                STATE_IAC_SB_DATA => {
                    if byte == IAC {
                        self.state = STATE_IAC_SB_IAC;
                    } else {
                        self.sb_data.push(byte);
                    }
                }
                STATE_IAC_SB_IAC => {
                    if byte == IAC {
                        // SB 数据中 IAC IAC → 透传 0xFF
                        self.sb_data.push(IAC);
                        self.state = STATE_IAC_SB_DATA;
                    } else if byte == SE {
                        // 子协商结束
                        let data = std::mem::take(&mut self.sb_data);
                        let option = self.sb_option;
                        events.push(ProtocolEvent::IacSb { option, data });
                        self.state = STATE_DATA;
                    } else {
                        // 异常终止，仍然派发已收集的数据
                        let data = std::mem::take(&mut self.sb_data);
                        let option = self.sb_option;
                        events.push(ProtocolEvent::IacSb { option, data });
                        self.state = STATE_DATA;
                    }
                }
                _ => self.state = STATE_DATA,
            }
        }

        // 派发干净数据
        if !self.clean_bytes.is_empty() {
            let buf = std::mem::take(&mut self.clean_bytes);
            let clean = super::c1_convert::decode_buffer_for_terminal(&buf);
            if !clean.is_empty() {
                events.push(ProtocolEvent::Data(clean));
            }
        }

        events
    }

    pub fn reset(&mut self) {
        self.state = STATE_DATA;
        self.sb_option = 0;
        self.sb_data.clear();
        self.clean_bytes.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_data_passthrough() {
        let mut p = ProtocolParser::new();
        let events = p.feed(b"hello");
        assert_eq!(events.len(), 1);
        if let ProtocolEvent::Data(s) = &events[0] {
            assert_eq!(s, "hello");
        } else {
            panic!("expected Data event");
        }
    }

    #[test]
    fn test_iac_do() {
        let mut p = ProtocolParser::new();
        let events = p.feed(&[IAC, DO, OPT_ECHO]);
        assert!(events.iter().any(|e| matches!(e, ProtocolEvent::IacDo(OPT_ECHO))));
    }

    #[test]
    fn test_iac_iac_escape() {
        let mut p = ProtocolParser::new();
        let events = p.feed(&[IAC, IAC]);
        assert_eq!(events.len(), 1);
        if let ProtocolEvent::Data(s) = &events[0] {
            assert_eq!(s.as_bytes(), &[IAC]);
        }
    }

    #[test]
    fn test_subnegotiation() {
        let mut p = ProtocolParser::new();
        let events = p.feed(&[IAC, SB, OPT_NAWS, 0, 24, IAC, SE]);
        assert!(events.iter().any(|e| matches!(e, ProtocolEvent::IacSb { option: OPT_NAWS, .. })));
    }
}
