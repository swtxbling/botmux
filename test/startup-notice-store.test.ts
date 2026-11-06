/**
 * 启动自检提醒的去重状态 —— 关键不变量：
 *   • 必须落盘（发提醒的启动自检只在 daemon 启动时跑一次，内存态每次重启清零 ⟹
 *     fleet 重启几次就发几条一模一样的私信，等于没去重）
 *   • key 是「提醒种类 + 内容摘要」：内容没变不再发，内容变了（缺的 scope 集合变了）要发
 *   • 问题解决后清掉记录 ⟹ 同一个问题复发能重新提醒
 *   • 只在私信确认发送成功后才写（先记后发 = 一次网络失败就永久静默丢失）
 */
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearStartupNotice,
  markStartupNoticeSent,
  startupNoticeDigest,
  wasStartupNoticeSent,
} from '../src/services/startup-notice-store.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'startup-notice-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const APP = 'cli_notice';
const digestOf = (...parts: string[]) => startupNoticeDigest(parts);

describe('启动自检提醒去重状态', () => {
  it('落盘后跨「进程重启」仍然有效（这正是不能放内存的原因）', () => {
    const digest = digestOf('critical', 'im:message');
    expect(wasStartupNoticeSent(dir, APP, 'required_scopes_missing', digest)).toBe(false);
    markStartupNoticeSent(dir, APP, 'required_scopes_missing', digest);
    // 重新读文件 ⟹ 等价于「重启后再问一次」。内存态实现在这一步返回 false。
    expect(wasStartupNoticeSent(dir, APP, 'required_scopes_missing', digest)).toBe(true);
    expect(existsSync(join(dir, 'startup-notices-cli_notice.json'))).toBe(true);
  });

  it('内容变了就该重新提醒（缺的 scope 集合变了是新情况）', () => {
    markStartupNoticeSent(dir, APP, 'required_scopes_missing', digestOf('critical', 'im:message'));
    expect(wasStartupNoticeSent(dir, APP, 'required_scopes_missing', digestOf('critical', 'im:message', 'im:message.group_msg'))).toBe(false);
  });

  it('不同种类的提醒互不干扰', () => {
    markStartupNoticeSent(dir, APP, 'required_scopes_missing', digestOf('x'));
    // 同一次启动里另一个自检项也该能发（不能因为共用文件就被前一条吞掉）
    expect(wasStartupNoticeSent(dir, APP, 'vc_scopes_missing', digestOf('x'))).toBe(false);
    markStartupNoticeSent(dir, APP, 'vc_scopes_missing', digestOf('x'));
    expect(wasStartupNoticeSent(dir, APP, 'vc_scopes_missing', digestOf('x'))).toBe(true);
    expect(wasStartupNoticeSent(dir, APP, 'required_scopes_missing', digestOf('x'))).toBe(true);
  });

  it('问题解决后清掉记录 ⟹ 同一个问题复发要重新提醒', () => {
    const digest = digestOf('critical', 'im:message');
    markStartupNoticeSent(dir, APP, 'required_scopes_missing', digest);
    clearStartupNotice(dir, APP, 'required_scopes_missing');
    expect(wasStartupNoticeSent(dir, APP, 'required_scopes_missing', digest)).toBe(false);
    // 清掉之后磁盘上的记录也没了（不是只清了内存视角）
    expect(existsSync(join(dir, 'startup-notices-cli_notice.json'))).toBe(true);
    markStartupNoticeSent(dir, APP, 'required_scopes_missing', digest);
    expect(wasStartupNoticeSent(dir, APP, 'required_scopes_missing', digest)).toBe(true);
  });

  it('没有记录时清理不写文件（启动时大多数 bot 都无事，不该为此多写盘）', () => {
    clearStartupNotice(dir, APP, 'required_scopes_missing');
    expect(existsSync(join(dir, 'startup-notices-cli_notice.json'))).toBe(false);
  });

  it('文件坏了当作没发过：宁可多提醒一次，不静默漏掉', () => {
    writeFileSync(join(dir, 'startup-notices-cli_notice.json'), '{ not json');
    expect(wasStartupNoticeSent(dir, APP, 'required_scopes_missing', digestOf('x'))).toBe(false);
  });

  it('按 app 隔离：别的 bot 的记录不会吞掉本 bot 的提醒', () => {
    markStartupNoticeSent(dir, 'cli_other', 'required_scopes_missing', digestOf('x'));
    expect(wasStartupNoticeSent(dir, APP, 'required_scopes_missing', digestOf('x'))).toBe(false);
  });
});
