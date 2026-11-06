/**
 * 启动自检提醒的「同一件事只说一次」状态 —— 给 daemon 启动时那几条管理员私信
 * （缺必需权限 / 缺 VC 权限 / 缺文档权限 / 缺 self_manage / VC 事件订阅失败）做去重。
 *
 * 为什么必须落盘：发这些提醒的 `checkRequiredScopes` / `ensureVcMeetingEventsSubscribed`
 * **只在 daemon 启动时跑一次**。内存态每次重启清零，而「缺一个权限」是个能挂几个月的
 * 状态 —— 主人管 15 个 bot，fleet 每重启一次就是 15 条一模一样的私信，本来就是重启，
 * 不是新消息。所以状态要跨进程活下来。
 *
 * key 用「notice 种类 + 内容摘要」而不是时间窗：`required_scopes_missing` 的摘要是
 * 缺失 scope 名字的排序集合，所以
 *   • 重启后同样还是缺这两项 → 摘要一样 → 不再发；
 *   • 又多缺了一项（或少的换了一项）→ 摘要变了 → 该发；
 *   • 补齐了（check 通过时调用 clelear 清掉记录）之后又坏了 → 记录已清 → 该发。
 * 刻意**不做**「N 天后再提醒一次」的兜底：那等于把刷屏按天续命，而问题是否还在，
 * 启动自检每次都会重新判定，有事必发、没事不发才是准的。
 *
 * ⚠️ 写入时机是**私信发送成功之后**（和 under-review-notify-store 同款约定）：先记
 * 后发的话，一次网络失败就把这条提醒永久静音了，而且是零信号的静默丢失。
 *
 * 文件按 app 隔离（`startup-notices-<larkAppId>.json`）；写者只有 daemon 进程本身
 * （单写者），原子写（唯一 tmp + rename）即可，无需跨进程锁。
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export type StartupNoticeKind =
  /** `checkRequiredScopes`：缺 BOTMUX_REQUIRED_SCOPES 里的 critical 权限。 */
  | 'required_scopes_missing'
  /** `checkRequiredScopes`：自动补齐权限的结果（已修复 / 没能全部落地，需人工收尾）。 */
  | 'scope_autofix_result'
  /** `checkRequiredScopes`：99991672，应用连自己的 scope 列表都查不到（缺 self_manage）。 */
  | 'scope_self_manage_missing'
  /** `checkRequiredScopes`：/watch-comment、/subscribe-lark-doc 已用但缺文档权限。 */
  | 'docs_scopes_missing'
  /** `checkRequiredScopes`：vcMeetingAgent 已启用但缺 VC 权限。 */
  | 'vc_scopes_missing'
  /** `ensureVcMeetingEventsSubscribed`：启动时补 VC 事件订阅失败。 */
  | 'vc_event_subscribe_failed';

interface NoticeRecord {
  /** 提醒内容摘要（见 {@link startupNoticeDigest}）。 */
  digest: string;
  /** 发送时间（仅诊断用，不参与判定 —— 判定只看 digest 是否相同）。 */
  notifiedAt: number;
}

interface StateFile {
  notices?: Partial<Record<StartupNoticeKind, NoticeRecord>>;
}

function filePath(dataDir: string, larkAppId: string): string {
  return join(dataDir, `startup-notices-${larkAppId}.json`);
}

function readState(dataDir: string, larkAppId: string): StateFile {
  const fp = filePath(dataDir, larkAppId);
  if (!existsSync(fp)) return {};
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed === 'object' && parsed.notices && typeof parsed.notices === 'object') {
      return parsed as StateFile;
    }
  } catch { /* corrupt — 当「什么都没发过」处理：宁可多提醒一次，不静默漏掉 */ }
  return {};
}

/**
 * 把一条提醒的「内容」压成摘要。parts 里放能区分问题的东西（缺哪些 scope、错误属于
 * 哪一类），**不要**放每次都变的内容（时间戳、完整错误文本），否则等于没去重。
 *
 * 顺序无关由调用方保证（scope 名字先排序），这里只做稳定拼接 + sha256。
 */
export function startupNoticeDigest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/** 这条提醒（同种类、同内容）是否已经成功发过了。文件读不出来时返回 false（该发）。 */
export function wasStartupNoticeSent(
  dataDir: string,
  larkAppId: string,
  kind: StartupNoticeKind,
  digest: string,
): boolean {
  return readState(dataDir, larkAppId).notices?.[kind]?.digest === digest;
}

/** 记下「这条提醒已经发过了」。**只在私信确认发送成功后调用。** */
export function markStartupNoticeSent(
  dataDir: string,
  larkAppId: string,
  kind: StartupNoticeKind,
  digest: string,
): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const state = readState(dataDir, larkAppId);
  const record: NoticeRecord = { digest, notifiedAt: Date.now() };
  state.notices = { ...state.notices, [kind]: record };
  atomicWriteFileSync(filePath(dataDir, larkAppId), JSON.stringify(state, null, 2) + '\n');
}

/**
 * 问题解决了（启动自检这一项通过了）就清掉记录：将来同一个问题再出现时能重新提醒。
 * 没有记录时不写文件（启动时大多数 bot 都是「没问题」，不该为此多写盘）。
 */
export function clearStartupNotice(
  dataDir: string,
  larkAppId: string,
  kind: StartupNoticeKind,
): void {
  const state = readState(dataDir, larkAppId);
  if (!state.notices?.[kind]) return;
  delete state.notices[kind];
  atomicWriteFileSync(filePath(dataDir, larkAppId), JSON.stringify(state, null, 2) + '\n');
}
