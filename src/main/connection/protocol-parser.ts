/**
 * 协议层状态机
 * 仅处理协议级解析（Telnet IAC、自定义 OSC），不处理 VT 渲染序列（由 xterm.js 处理）
 */

import { decodeBufferForTerminal } from './c1-convert'

/** 协议解析器状态 */
export const ParserState = {
  DATA: 0,        // 正常数据透传
  IAC: 1,         // 遇到 0xFF，等待命令字节
  IAC_DO: 2,      // IAC DO，等待选项字节
  IAC_DONT: 3,    // IAC DONT
  IAC_WILL: 4,    // IAC WILL
  IAC_WONT: 5,    // IAC WONT
  IAC_SB: 6,      // IAC SB，子协商开始
  IAC_SB_DATA: 7, // 子协商数据，收集到 IAC SE
  IAC_SB_IAC: 8,  // 子协商中遇到 IAC，等待 SE 或 IAC
} as const
export type ParserState = typeof ParserState[keyof typeof ParserState]

/** Telnet IAC 常量 */
const IAC = 255
const DO = 253
const DONT = 254
const WILL = 251
const WONT = 252
const SB = 250
const SE = 240

/** Telnet 选项常量 */
const OPT_ECHO = 1
const OPT_SUPPRESS_GO_AHEAD = 3
const OPT_NAWS = 31

/** 协议事件 */
export interface ProtocolEvents {
  data: string
  iacDo: number
  iacDont: number
  iacWill: number
  iacWont: number
  iacSb: { option: number; data: Buffer }
}

type EventCallback<T> = (value: T) => void

export class ProtocolParser {
  private state = ParserState.DATA
  private sbOption = 0
  private sbData: number[] = []
  private cleanBytes: number[] = []
  private callbacks: { [K in keyof ProtocolEvents]?: EventCallback<ProtocolEvents[K]>[] } = {}

  /** 输入原始字节流，返回剥离 IAC 后的干净 UTF-8 数据 */
  feed(raw: Buffer): string {
    for (let i = 0; i < raw.length; i++) {
      const byte = raw[i]

      switch (this.state) {
        case ParserState.DATA:
          if (byte === IAC) {
            this.state = ParserState.IAC
          } else {
            this.cleanBytes.push(byte)
          }
          break

        case ParserState.IAC:
          if (byte === IAC) {
            this.cleanBytes.push(IAC)
            this.state = ParserState.DATA
          } else if (byte === DO) {
            this.state = ParserState.IAC_DO
          } else if (byte === DONT) {
            this.state = ParserState.IAC_DONT
          } else if (byte === WILL) {
            this.state = ParserState.IAC_WILL
          } else if (byte === WONT) {
            this.state = ParserState.IAC_WONT
          } else if (byte === SB) {
            this.state = ParserState.IAC_SB
          } else {
            this.state = ParserState.DATA
          }
          break

        case ParserState.IAC_DO:
          this.emit('iacDo', byte)
          this.state = ParserState.DATA
          break

        case ParserState.IAC_DONT:
          this.emit('iacDont', byte)
          this.state = ParserState.DATA
          break

        case ParserState.IAC_WILL:
          this.emit('iacWill', byte)
          this.state = ParserState.DATA
          break

        case ParserState.IAC_WONT:
          this.emit('iacWont', byte)
          this.state = ParserState.DATA
          break

        case ParserState.IAC_SB:
          this.sbOption = byte
          this.sbData = []
          this.state = ParserState.IAC_SB_DATA
          break

        case ParserState.IAC_SB_DATA:
          if (byte === IAC) {
            this.state = ParserState.IAC_SB_IAC
          } else {
            this.sbData.push(byte)
          }
          break

        case ParserState.IAC_SB_IAC:
          if (byte === IAC) {
            this.sbData.push(IAC)
            this.state = ParserState.IAC_SB_DATA
          } else if (byte === SE) {
            this.emit('iacSb', { option: this.sbOption, data: Buffer.from(this.sbData) })
            this.state = ParserState.DATA
          } else {
            this.emit('iacSb', { option: this.sbOption, data: Buffer.from(this.sbData) })
            this.state = ParserState.DATA
          }
          break
      }
    }

    if (this.cleanBytes.length) {
      const cleanBuf = Buffer.from(this.cleanBytes)
      this.cleanBytes = []
      const clean = decodeBufferForTerminal(cleanBuf)
      this.emit('data', clean)
      return clean
    }

    return ''
  }

  on<K extends keyof ProtocolEvents>(event: K, callback: EventCallback<ProtocolEvents[K]>): void {
    if (!this.callbacks[event]) {
      this.callbacks[event] = []
    }
    this.callbacks[event]!.push(callback)
  }

  off<K extends keyof ProtocolEvents>(event: K, callback: EventCallback<ProtocolEvents[K]>): void {
    const list = this.callbacks[event]
    if (list) {
      const idx = list.indexOf(callback as any)
      if (idx >= 0) list.splice(idx, 1)
    }
  }

  reset(): void {
    this.state = ParserState.DATA
    this.sbOption = 0
    this.sbData = []
  }

  private emit<K extends keyof ProtocolEvents>(event: K, value: ProtocolEvents[K]): void {
    const list = this.callbacks[event]
    if (list) {
      for (const cb of list) {
        (cb as EventCallback<any>)(value)
      }
    }
  }
}

export { IAC, DO, DONT, WILL, WONT, SB, SE, OPT_ECHO, OPT_SUPPRESS_GO_AHEAD, OPT_NAWS }
