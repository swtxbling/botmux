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
 *  2. **Merge per anchor.** Notices bound for the SAME reply anchor inside a
 *     short window become one message that names every affected session.
 *     THE MERGE COVERS ONLY SESSIONS SHARING ONE ANCHOR (`sessionAnchorId` —
 *     one thread / chat; plus the session itself for private-reply sessions,
 *     which go to a requester rather than the chat). Each bot runs its own
 *     daemon process and posts into its own chats/topics, so **cross-bot
 *     crashes are never merged**; re-routing them into one thread would move
 *     the notice away from where the owner expects it (separate decision).
 *
 * Size budget is in BYTES (`Buffer.byteLength`), not characters: the Feishu
 * card limit is a byte limit, and CJK terminal output is ~3 bytes/char. A
 * char-based budget let 10 × 2000 CJK chars (~56KB) through, so both send
 * attempts failed and the whole batch was lost.
 */
import { createReplyCard, type ReplyCardV2 } from '../im/lark/md-card.js';
import { t as tr, type Locale } from '../i18n/index.js';

/** How long a first notice waits for siblings bound for the same anchor. */
export const CRASH_NOTICE_MERGE_WINDOW_MS = 10_000;
/** One re-send attempt before the batch is reported as lost. */
export const CRASH_NOTICE_RETRY_DELAY_MS = 2_000;
/** Per-entry tail bounds (the full worker tail is already ≤ 2.5k chars). */
const TAIL_MAX_LINES = 20;
const TAIL_MAX_BYTES = 3_500;
/** Whole-tail budget: Feishu rejects card bodies over ~30KB (bytes!). */
const TAIL_TOTAL_MAX_BYTES = 18_000;
const SESSION_LABEL_MAX_CHARS = 40;
/** A crash storm must not produce a card nobody can read. */
const MAX_LISTED_SESSIONS = 20;

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
  /** Asked again at flush time: the session left the state this notice
   *  described (closed / replaced / another crash generation), so the notice
   *  would be misleading — skip it and log instead. */
  stillRelevant?: () => boolean;
  /** Called once the batch could not be delivered — e.g. the root message was
   *  withdrawn, which is the lifecycle owner's cue to close the session. Only
   *  the entry whose route anchored the send is asked (one message = one
   *  lifecycle owner); the rest are logged. */
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

/** Keep the tail's LAST `maxBytes` UTF-8 bytes (never split a character). */
function tailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return text;
  let start = buf.byteLength - maxBytes;
  // 0b10xxxxxx = UTF-8 continuation byte: move forward to the next boundary.
  while (start < buf.byteLength && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf8');
}

/** Trim a captured terminal tail to its last lines, for the folded panel. */
export function trimCrashTail(
  text: string | undefined,
  maxLines: number = TAIL_MAX_LINES,
  maxBytes: number = TAIL_MAX_BYTES,
): string | undefined {
  if (!text) return undefined;
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/\s+$/, ''));
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
  while (lines.length > maxLines) lines.shift();
  return tailBytes(lines.join('\n'), maxBytes).trim() || undefined;
}

function truncateLabel(label: string): string {
  const trimmed = label.replace(/[\r\n]+/g, ' ').trim();
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

/** Session labels are user text and land in markdown: never let them open a
 *  fence, bold run or link. */
function escapeLabel(label: string): string {
  return label.replace(/[\\`*_[\]~<>]/g, ch => `\\${ch}`);
}

/** Fence longer than any backtick run inside the text, so terminal output
 *  containing ``` can never break out of (or into) the code block. */
function fenced(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
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
  return `**${escapeLabel(entry.sessionLabel)}** · ${source}\n${fenced(tail)}`;
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
  const listed = entries.slice(0, MAX_LISTED_SESSIONS);
  const listSep = tr('worker.crash_notice_list_sep', undefined, loc);
  const sentence = merged
    ? tr('worker.crash_notice_merged', {
      count: entries.length,
      cliNames: [...new Set(entries.map(e => e.cliName))].join(listSep),
    }, loc)
    : first.reason === 'permanent_exit'
      ? tr('worker.crash_permanent_exit_stopped', { cliName: first.cliName, code: first.code ?? '?' }, loc)
      : tr('worker.crash_loop_stopped', { cliName: first.cliName, count: first.count }, loc);

  const elements: Record<string, unknown>[] = [{ tag: 'markdown', content: sentence }];

  if (merged) {
    elements.push({
      tag: 'markdown',
      content: tr('worker.crash_notice_sessions', {
        sessions: listed
          .map(entry => tr('worker.crash_entry_pair', {
            label: escapeLabel(entry.sessionLabel),
            detail: entryDetail(entry, loc),
          }, loc))
          .join(listSep),
      }, loc),
    });
    if (entries.length > listed.length) {
      elements.push({
        tag: 'markdown',
        text_size: 'notation',
        content: tr('worker.crash_notice_more_sessions', { count: entries.length - listed.length }, loc),
      });
    }
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

  // Budget in bytes: the Feishu limit is a byte limit (CJK ≈ 3 bytes/char).
  const tails: string[] = [];
  let tailBudget = TAIL_TOTAL_MAX_BYTES;
  let omitted = 0;
  for (const entry of listed) {
    const block = entryTail(entry, loc);
    if (!block) continue;
    const bytes = Buffer.byteLength(block, 'utf8');
    if (bytes > tailBudget) { omitted++; continue; }
    tailBudget -= bytes;
    tails.push(block);
  }
  const tailElements: Record<string, unknown>[] = [];
  if (tails.length > 0) {
    tailElements.push({ tag: 'markdown', content: tails.join('\n\n') });
    if (omitted > 0) {
      tailElements.push({
        tag: 'markdown',
        text_size: 'notation',
        content: tr('worker.crash_tail_omitted', { count: omitted }, loc),
      });
    }
  }
  if (tailElements.length > 0) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: { tag: 'plain_text', content: tr('worker.crash_tail_title', undefined, loc) },
        icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined' },
        icon_position: 'right',
        icon_expanded_angle: -180,
      },
      border: { color: 'grey', corner_radius: '5px' },
      padding: '8px 8px 8px 8px',
      elements: tailElements,
    });
  }

  return createReplyCard(elements);
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

/**
 * In-process batcher keyed by reply anchor. Every queued notice is eventually
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

  /** Deliver now instead of waiting out the window (shutdown / tests). */
  async flushNow(): Promise<void> {
    for (const key of [...this.batches.keys()]) await this.flush(key);
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

    const relevant = batch.items.filter(item => {
      if (!item.stillRelevant || item.stillRelevant()) return true;
      this.log.warn?.(`[crash-notice] skipping notice for session ${item.entry.sessionId}: session is no longer in the state it crashed in`);
      return false;
    });
    if (relevant.length === 0) return;

    const primary = relevant[0];
    const cardJson = JSON.stringify(buildCrashNoticeCard(relevant.map(item => item.entry), primary.locale));
    const ids = relevant.map(item => item.entry.sessionId).join(', ');

    const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise<void>(resolve => unrefTimer(setTimeout(resolve, this.retryDelayMs)));
      try {
        await primary.send(cardJson);
        return;
      } catch (err) {
        lastError = err;
        this.log.error?.(`[crash-notice] send failed (attempt ${attempt + 1}/2, sessions: ${ids}): ${describe(err)}`);
      }
    }
    this.log.error?.(`[crash-notice] notice not delivered (sessions: ${ids}): ${describe(lastError)}`);
    // One card = one reply route. Only its owning entry may act on the failure
    // (e.g. close a session whose root message was withdrawn); the others were
    // merely named in that card.
    try {
      await primary.onSendError?.(lastError);
    } catch (hookErr) {
      this.log.warn?.(`[crash-notice] onSendError failed (session: ${primary.entry.sessionId}): ${describe(hookErr)}`);
    }
    for (const item of relevant.slice(1)) {
      this.log.error?.(`[crash-notice] no delivery hook for session ${item.entry.sessionId} (batch anchored on ${primary.entry.sessionId}); it was named in an undelivered card`);
    }
  }
}
