/**
 * Telnet IAC 协议层
 * 使用 ProtocolParser 状态机处理 IAC 协商
 */
import { Socket } from 'net'
import { ProtocolParser, IAC, DO, DONT, WILL, WONT, SB, SE, OPT_ECHO, OPT_SUPPRESS_GO_AHEAD, OPT_NAWS } from './protocol-parser'

export class TelnetProtocol {
  private parser: ProtocolParser
  private socket: Socket
  private cols: number
  private rows: number

  constructor(socket: Socket, initialCols = 80, initialRows = 24) {
    this.socket = socket
    this.cols = initialCols
    this.rows = initialRows
    this.parser = new ProtocolParser()

    this.parser.on('iacDo', (opt) => this.handleDo(opt))
    this.parser.on('iacDont', () => { /* 忽略 */ })
    this.parser.on('iacWill', (opt) => this.handleWill(opt))
    this.parser.on('iacWont', () => { /* 忽略 */ })
    this.parser.on('iacSb', () => { /* 忽略服务端子协商 */ })
  }

  /** 输入原始 TCP 数据，返回干净的 UTF-8 数据 */
  feed(raw: Buffer): string {
    return this.parser.feed(raw)
  }

  /** 更新终端尺寸并发送 NAWS */
  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.sendNaws()
  }

  private handleDo(opt: number): void {
    if (opt === OPT_NAWS || opt === OPT_SUPPRESS_GO_AHEAD) {
      this.socket.write(Buffer.from([IAC, WILL, opt]))
      if (opt === OPT_NAWS) this.sendNaws()
    } else {
      this.socket.write(Buffer.from([IAC, WONT, opt]))
    }
  }

  private handleWill(opt: number): void {
    if (opt === OPT_ECHO || opt === OPT_SUPPRESS_GO_AHEAD) {
      this.socket.write(Buffer.from([IAC, DO, opt]))
    } else {
      this.socket.write(Buffer.from([IAC, DONT, opt]))
    }
  }

  private sendNaws(): void {
    if (!this.socket.writable) return
    const naws = Buffer.alloc(9)
    naws[0] = IAC
    naws[1] = SB
    naws[2] = OPT_NAWS
    naws[3] = (this.cols >> 8) & 0xff
    naws[4] = this.cols & 0xff
    naws[5] = (this.rows >> 8) & 0xff
    naws[6] = this.rows & 0xff
    naws[7] = IAC
    naws[8] = SE
    this.socket.write(naws)
  }
}
