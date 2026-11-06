/**
 * CLI crash / auto-restart-stopped notice.
 *
 * Before this module the daemon posted one plain-text message per crashed
 * session, with the raw terminal tail pasted into the message body
 * (`worker.crash_recent_output`). When several sessions hit the same failure
 * together the owner got a wall of near-identical blocks of terminal noise.
 *
 * Two rules live here:
 *
 *  1. **Card, not raw text.** Body = one plain-language sentence (what
 *     happened + what botmux did / what to do). The terminal tail is still
 *     available, but folded into a `collapsible_panel` so it costs no screen
 *     space until someone opens it.
 *  2. **Merge per recipient.** Notices bound for the SAME recipient inside a
 *     short window become one message that names every affected session.
 *     Recipient identity is the repo's existing reply route: bot + chat
 *     anchor (`sessionAnchorId`), plus the session itself for private-reply
 *     sessions (those go to a requester, not the chat). Every bot is its own
 *     daemon process, so this merge is intentionally in-process: crash
 *     notices from different bots land in different chats (or different
 *     topics), i.e. different recipients — merging them would move the
 *     message away from where the owner expects it.
 */
import { createReplyCard, type ReplyCardV2 } from '../im/lark/md-card.js';
import { t as tr, type Locale } from '../i18n/index.js';

/** How long a first notice waits for siblings bound for the same recipient. */
export const CRASH_NOTICE_MERGE_WINDOW_MS = 10_000;
/** One re-send attempt before the batch is reported as lost. */
export const CRASH_NOTICE_RETRY_DELAY_MS = 2_000;
/** Per-entry tail bounds (the full worker tail is already ≤ 2.5k chars). */
const TAIL_MAX_LINES = 20;
const TAIL_MAX_CHARS = 2_000;
/** Whole-card bound: Feishu rejects bodies over ~30KB. */
const TAIL_TOTAL_MAX_CHARS = 20_000;
const SESSION_LABEL_MAX_CHARS = 40;

export type CrashNoticeReason = 'crash_loop' | 'permanent_exit';

/** Everything one crashed session contributes to the notice. */
export interface CrashNoticeEntry {
  sessionId: string;
  /** Human label for the owner (session title, else turn title, else CLI). */
  sessionLabel: string;
  cliName: string;
  reason: CrashNoticeReason;
  /** Crash count for `crash_loop`, stop attempt count for `permanent_exit`. */
  count: number;
  code?: number | null;
  /** Raw terminal tail captured by the worker (preferred source). */
  logTail?: string;
  /** Daemon-side per-worker stderr ring, when the worker could not capture. */
  workerStderrTail?: string;
  /** The web terminal kept the last startup output, so it is worth opening. */
  diagnosticAvailable?: boolean;
  /** bwrap namespace refusal explanation reported by the worker. */
  sandboxNotice?: string;
}

export interface CrashNoticeBatchItem {
  entry: CrashNoticeEntry;
  locale?: Locale;
  /** Post the rendered card (msgType `interactive`). */
  send: (cardJson: string) => Promise<unknown>;
  /** Called once the batch could not be delivered — e.g. the root message was
   *  withdrawn, which is the lifecycle owner's cue to close the session. */
  onSendError?: (err: unknown) => void | Promise<void>;
}

interface PendingBatch {
  items: CrashNoticeBatchItem[];
  timer: ReturnType<typeof setTimeout> | null;
}

export interface CrashNoticeBatcherOptions {
  windowMs?: number;
  retryDelayMs?: number;
  log?: { warn?: (msg: string) => void; error?: (msg: string) => void };
}

/** Trim a captured terminal tail to its last lines, for the folded panel. */
export function trimCrashTail(
  text: string | undefined,
  maxLines: number = TAIL_MAX_LINES,
  maxChars: number = TAIL_MAX_CHARS,
): string | undefined {
  if (!text) return undefined;
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/\s+$/, ''));
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
  while (lines.length > maxLines) lines.shift();
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(out.length - maxChars);
  out = out.trim();
  return out || undefined;
}

function truncateLabel(label: string): string {
  const trimmed = label.trim();
  return trimmed.length > SESSION_LABEL_MAX_CHARS
    ? `${trimmed.slice(0, SESSION_LABEL_MAX_CHARS - 1)}…`
    : trimmed;
}

/** Session title → turn title → CLI name. Never empty. */
export function crashNoticeLabel(
  title: string | undefined,
  turnTitle: string | undefined,
  cliName: string,
): string {
  for (const candidate of [title, turnTitle, cliName]) {
    if (candidate && candidate.trim()) return truncateLabel(candidate);
  }
  return cliName;
}

function entryDetail(entry: CrashNoticeEntry, loc?: Locale): string {
  return entry.reason === 'permanent_exit'
    ? tr('worker.crash_entry_permanent', { code: entry.code ?? '?' }, loc)
    : tr('worker.crash_entry_loop', { count: entry.count }, loc);
}

function entryTail(entry: CrashNoticeEntry, loc?: Locale): string | undefined {
  const tail = trimCrashTail(entry.logTail ?? entry.workerStderrTail);
  if (!tail) return undefined;
  const source = entry.logTail
    ? tr('worker.crash_recent_output', undefined, loc)
    : tr('workerDiag.recentStderr', undefined, loc);
  return `**${entry.sessionLabel}** · ${source}\n\`\`\`\n${tail}\n\`\`\``;
}

/**
 * Render the notice. Element 0 is always the one-sentence summary, so a
 * preview / notification line shows the plain sentence rather than terminal
 * output; the raw tails only ever appear inside the folded panel.
 */
export function buildCrashNoticeCard(entries: readonly CrashNoticeEntry[], loc?: Locale): ReplyCardV2 {
  if (entries.length === 0) throw new Error('crash notice needs at least one entry');
  const merged = entries.length > 1;
  const first = entries[0];
  const sentence = merged
    ? tr('worker.crash_notice_merged', {
      count: entries.length,
      cliNames: [...new Set(entries.map(e => e.cliName))].join(tr('worker.crash_notice_list_sep', undefined, loc)),
    }, loc)
    : first.reason === 'permanent_exit'
      ? tr('worker.crash_permanent_exit_stopped', { cliName: first.cliName, code: first.code ?? '?' }, loc)
      : tr('worker.crash_loop_stopped', { cliName: first.cliName, count: first.count }, loc);

  const elements: Record<string, unknown>[] = [{ tag: 'markdown', content: sentence }];

  if (merged) {
    const listed = entries
      .map(entry => `${entry.sessionLabel}（${entryDetail(entry, loc)}）`)
      .join(tr('worker.crash_notice_list_sep', undefined, loc));
    elements.push({
      tag: 'markdown',
      content: tr('worker.crash_notice_sessions', { sessions: listed }, loc),
    });
  }

  const diagnosticVisible = entries.some(entry => entry.diagnosticAvailable);
  if (diagnosticVisible) {
    elements.push({
      tag: 'markdown',
      text_size: 'notation',
      content: `<font color='grey'>${tr('worker.crash_diagnostic_terminal', undefined, loc)}</font>`,
    });
  }

  for (const notice of new Set(entries.map(entry => entry.sandboxNotice).filter(Boolean))) {
    elements.push({ tag: 'markdown', text_size: 'notation', content: String(notice) });
  }

  const tails: string[] = [];
  let tailBudget = TAIL_TOTAL_MAX_CHARS;
  for (const entry of entries) {
    const block = entryTail(entry, loc);
    if (!block || block.length > tailBudget) continue;
    tailBudget -= block.length;
    tails.push(block);
  }
  if (tails.length > 0) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: { tag: 'plain_text', content: tr('worker.crash_recent_output', undefined, loc) },
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined' },
        icon_position: 'right',
        icon_expanded_angle: -180,
      },
      border: { color: 'grey', corner_radius: '5px' },
      padding: '8px 8px 8px 8px',
      elements: [{ tag: 'markdown', content: tails.join('\n\n') }],
    });
  }

  return createReplyCard(elements);
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

/**
 * In-process batcher keyed by recipient. Every queued notice is eventually
 * either delivered or reported through `log.error` naming the affected
 * sessions — a send failure never drops the batch silently.
 */
export class CrashNoticeBatcher {
  private readonly batches = new Map<string, PendingBatch>();
  private readonly windowMs: number;
  private readonly retryDelayMs: number;
  private readonly log: { warn?: (msg: string) => void; error?: (msg: string) => void };

  constructor(opts: CrashNoticeBatcherOptions = {}) {
    this.windowMs = Math.max(0, opts.windowMs ?? CRASH_NOTICE_MERGE_WINDOW_MS);
    this.retryDelayMs = Math.max(0, opts.retryDelayMs ?? CRASH_NOTICE_RETRY_DELAY_MS);
    this.log = opts.log ?? {};
  }

  /** Queue one notice. The first entry for a key starts the merge window. */
  enqueue(key: string, item: CrashNoticeBatchItem): void {
    const existing = this.batches.get(key);
    if (existing) {
      existing.items.push(item);
      return;
    }
    const timer = setTimeout(() => { void this.flush(key); }, this.windowMs);
    unrefTimer(timer);
    this.batches.set(key, { items: [item], timer });
    // A zero window means "no merging": flush on the current turn instead of
    // parking the notice behind a timer tick.
    if (this.windowMs === 0) void this.flush(key);
  }

  pendingKeys(): string[] {
    return [...this.batches.keys()];
  }

  /** Deliver now instead of waiting out the window (tests / shutdown). */
  async flushNow(key?: string): Promise<void> {
    const keys = key === undefined ? [...this.batches.keys()] : [key];
    for (const k of keys) await this.flush(k);
  }

  /** Drop queued notices without sending (test isolation). */
  dispose(): void {
    for (const batch of this.batches.values()) if (batch.timer) clearTimeout(batch.timer);
    this.batches.clear();
  }

  private async flush(key: string): Promise<void> {
    const batch = this.batches.get(key);
    if (!batch) return;
    this.batches.delete(key);
    if (batch.timer) clearTimeout(batch.timer);

    const cardJson = JSON.stringify(buildCrashNoticeCard(batch.items.map(item => item.entry), batch.items[0]?.locale));
    const ids = batch.items.map(item => item.entry.sessionId).join(', ');
    const send = batch.items[0]?.send;

    const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise<void>(resolve => unrefTimer(setTimeout(resolve, this.retryDelayMs)));
      try {
        await send?.(cardJson);
        return;
      } catch (err) {
        lastError = err;
        this.log.error?.(`[crash-notice] send failed (attempt ${attempt + 1}/2, sessions: ${ids}): ${describe(err)}`);
      }
    }
    this.log.error?.(`[crash-notice] notice not delivered (sessions: ${ids}): ${describe(lastError)}`);
    for (const item of batch.items) {
      try { await item.onSendError?.(lastError); } catch (hookErr) {
        this.log.warn?.(`[crash-notice] onSendError failed (session: ${item.entry.sessionId}): ${describe(hookErr)}`);
      }
    }
  }
}
