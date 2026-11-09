/**
 * 群级默认目录 — 把 chat_id → 默认 workingDir 持久化到 bots.json 的 `chatWorkingDirs`，
 * 并同步内存里的 BotConfig，改完无需重启 daemon。
 *
 * 与 oncall 绑定（oncall-store.ts）的唯一区别：这里只决定「本 bot 在本群新会话落在哪个目录」，
 * 不改任何对话权限——群成员能否和 bot 对话仍按 allowedUsers / 授权判断。同群两者都配置时
 * oncall 绑定的目录优先（见 bot-registry `findChatBoundWorkingDir`）。
 *
 * 写入走 rmwBotEntry（带文件锁的读改写），多 daemon 共享 bots.json 也不会丢更新。
 */
import { findChatWorkingDir, getBot, type OncallChat } from '../bot-registry.js';
import { rmwBotEntry } from './config-store.js';
import { logger } from '../utils/logger.js';

export async function bindChatWorkingDir(
  larkAppId: string,
  chatId: string,
  workingDir: string,
): Promise<{ ok: true; entry: OncallChat; created: boolean } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const next: OncallChat = { chatId, workingDir };

  const r = await rmwBotEntry<{ created: boolean }>(larkAppId, (entry) => {
    const cur: any[] = Array.isArray(entry.chatWorkingDirs) ? entry.chatWorkingDirs : [];
    const curIdx = cur.findIndex((c: any) => c?.chatId === chatId);
    const created = curIdx < 0;
    if (created) cur.push(next);
    else cur[curIdx] = next;
    entry.chatWorkingDirs = cur;
    return { write: true, result: { created } };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  const inMem = (bot.config.chatWorkingDirs ??= []);
  const memIdx = inMem.findIndex(c => c.chatId === chatId);
  if (memIdx >= 0) inMem[memIdx] = next; else inMem.push(next);

  logger.info(`[chat-dir:${larkAppId}] bind chat=${chatId} dir=${workingDir}`);
  return { ok: true, entry: next, created: r.result.created };
}

/** 幂等：未绑定也返回 ok，`wasBound` 说明是否真的删掉了一条。 */
export async function unbindChatWorkingDir(
  larkAppId: string,
  chatId: string,
): Promise<{ ok: true; wasBound: boolean } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const r = await rmwBotEntry<{ wasBound: boolean }>(larkAppId, (entry) => {
    const cur: OncallChat[] = Array.isArray(entry.chatWorkingDirs) ? entry.chatWorkingDirs : [];
    const wasBound = cur.some(c => c?.chatId === chatId);
    if (!wasBound) return { write: false, result: { wasBound } };
    entry.chatWorkingDirs = cur.filter((c: OncallChat) => c?.chatId !== chatId);
    return { write: true, result: { wasBound } };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  if (bot.config.chatWorkingDirs) {
    bot.config.chatWorkingDirs = bot.config.chatWorkingDirs.filter(c => c.chatId !== chatId);
  }
  logger.info(`[chat-dir:${larkAppId}] unbind chat=${chatId} wasBound=${r.result.wasBound}`);
  return { ok: true, wasBound: r.result.wasBound };
}

export function getChatWorkingDirStatus(larkAppId: string, chatId: string): OncallChat | undefined {
  try { getBot(larkAppId); } catch { return undefined; }
  return findChatWorkingDir(larkAppId, chatId);
}
