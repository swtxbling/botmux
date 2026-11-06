/**
 * Account-wide @owner budget for CLI rate/usage-limit notices.
 *
 * One account limit usually hits every busy topic of every bot sharing that
 * account within a few minutes. Each topic still gets its own "paused" notice
 * (so the topic shows why it stopped), but only the first one in a limit
 * episode @-mentions the owner. The window lasts until the reported reset time,
 * at least RATE_LIMIT_MENTION_MIN_WINDOW_MS and at most
 * RATE_LIMIT_MENTION_MAX_WINDOW_MS, so a fresh limit after the reset pings
 * again.
 *
 * Dedupe has two layers:
 *  - an in-memory Map per process (bot daemon), the fast path;
 *  - a claim file under `<dataDir>/rate-limit-mention/` shared by every daemon
 *    that runs the same CLI account for the same person. Account = CLI family +
 *    canonical config home (that is where the credentials live); person =
 *    `union_id`, which — unlike the app-scoped open_id — is the same under every
 *    bot's Feishu app. Callers that cannot name both keep the per-process
 *    behavior by omitting them.
 *
 * The file is claimed with O_EXCL and replaced (expired takeover) by an atomic
 * rename followed by a re-read: only the token actually present in the file may
 * @. Crash cleanup relies on `expiresAt`, never on unlinking.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { resolveBotmuxDataDir } from '../core/data-dir.js';

export type RateLimitMentionKind = 'usage' | 'rate';

export const RATE_LIMIT_MENTION_MIN_WINDOW_MS = 5 * 60 * 1_000;
// Capped at one hour: a mis-parsed or bogus far-away reset time must not
// silence a genuinely new limit for long.
export const RATE_LIMIT_MENTION_MAX_WINDOW_MS = 60 * 60 * 1_000;

const CROSS_PROCESS_DIR = 'rate-limit-mention';

const claims = new Map<string, { expiresAt: number; token: number }>();
const fileClaims = new Map<number, { path: string; token: string }>();
let nextToken = 0;

export interface RateLimitMentionClaimInput {
  larkAppId: string;
  ownerOpenId: string;
  /**
   * Tenant-stable `union_id` of the same owner. Enables the cross-process
   * claim; omit it (older sessions) and this stays per-process, because
   * open_ids differ between bots and deduping on them would be meaningless.
   */
  ownerUnionId?: string;
  kind: RateLimitMentionKind;
  retryAtMs: number;
  /** CLI account identity from {@link rateLimitMentionAccountKey}. */
  accountKey?: string;
  now?: number;
}

/**
 * Account identity for the cross-process claim: CLI family + the canonical
 * config home its credentials live in. Two bot daemons point at the same
 * account only when both parts match. Returns undefined when no home is
 * resolvable (caller keeps the per-process budget).
 */
export function rateLimitMentionAccountKey(
  cliFamily: string,
  configHome: string | undefined,
): string | undefined {
  const raw = configHome?.trim();
  if (!raw || !cliFamily) return undefined;
  const expanded = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
  if (!isAbsolute(expanded)) return undefined;
  let canonical: string;
  try {
    canonical = realpathSync(expanded);
  } catch {
    // Not created yet is fine — both bots resolve the same absolute path.
    canonical = resolve(expanded);
  }
  return `${cliFamily}:${canonical}`;
}

interface ClaimFileContents {
  expiresAt: number;
  token: string;
  larkAppId: string;
}

/**
 * Three states, because "cannot read" and "readable but garbage" must not be
 * conflated: a missing file or a half-written one (crash between create and
 * write) is free to take over, while an unreadable file (EACCES…) proves
 * nothing and must fail open — never silence a real limit notice.
 */
type ClaimFileRead = { kind: 'ok'; contents?: ClaimFileContents } | { kind: 'error' };

function readClaimFile(path: string): ClaimFileRead {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'ok' } : { kind: 'error' };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ClaimFileContents> | null;
    if (!parsed || typeof parsed !== 'object') return { kind: 'ok' };
    const expiresAt = Number(parsed.expiresAt);
    if (!Number.isFinite(expiresAt)) return { kind: 'ok' };
    if (typeof parsed.token !== 'string' || !parsed.token) return { kind: 'ok' };
    if (typeof parsed.larkAppId !== 'string') return { kind: 'ok' };
    return { kind: 'ok', contents: { expiresAt, token: parsed.token, larkAppId: parsed.larkAppId } };
  } catch {
    return { kind: 'ok' };
  }
}

/** O_CREAT|O_EXCL is atomic across processes: exactly one creator wins. */
function createClaimFileExclusive(path: string, contents: ClaimFileContents): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(contents));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    // Never leave a half-written claim behind; an empty file would read as
    // expired and merely be taken over, but cleaning up keeps the dir honest.
    try { unlinkSync(path); } catch { /* nothing to clean up */ }
    throw error;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * Replace an expired claim. The rename is atomic, and the re-read decides the
 * winner: only the process whose token is actually in the file reports a
 * claim. Two sequential takeovers can both see their own token (the loser's
 * rename lands after the winner's re-read), which costs at most one extra @ —
 * never a missed one. A filesystem error here fails open (`unavailable`): the
 * notice must still go out, just without the cross-process claim.
 */
function takeoverClaimFile(
  path: string,
  contents: ClaimFileContents,
): 'claimed' | 'lost' | 'unavailable' {
  const tmp = `${path}.${contents.token}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(contents), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return 'unavailable';
  }
  const current = readClaimFile(path);
  if (current.kind === 'error') return 'unavailable';
  return current.contents?.token === contents.token ? 'claimed' : 'lost';
}

type CrossProcessResult = { path: string; token: string } | 'denied' | 'unavailable';

function claimCrossProcess(input: {
  accountKey: string;
  ownerUnionId: string;
  kind: RateLimitMentionKind;
  larkAppId: string;
  expiresAt: number;
  now: number;
}): CrossProcessResult {
  const digest = createHash('sha256')
    .update(`${input.accountKey}\n${input.ownerUnionId}\n${input.kind}`)
    .digest('hex');
  const dir = join(resolveBotmuxDataDir(), CROSS_PROCESS_DIR);
  const path = join(dir, `${digest}.json`);
  const token = randomUUID();
  const contents: ClaimFileContents = {
    expiresAt: input.expiresAt,
    token,
    larkAppId: input.larkAppId,
  };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (createClaimFileExclusive(path, contents)) return { path, token };
  } catch {
    // Unwritable data dir must not silence a real limit notice.
    return 'unavailable';
  }
  const existing = readClaimFile(path);
  // Unreadable (EACCES…) proves nothing: fail open rather than silence.
  if (existing.kind === 'error') return 'unavailable';
  const live = existing.contents;
  // Bots disagree slightly on the reset time, so the comparison is against the
  // stored expiry, not equality with ours. A far-future expiry can only be a
  // clock jump or a hand-edited file — taking it at face value would silence
  // this account+owner+kind for up to that bogus horizon, so treat it as
  // corrupt and take the claim over.
  if (live && live.expiresAt > input.now
    && live.expiresAt <= input.now + RATE_LIMIT_MENTION_MAX_WINDOW_MS) return 'denied';
  const taken = takeoverClaimFile(path, contents);
  if (taken === 'claimed') return { path, token };
  return taken === 'lost' ? 'denied' : 'unavailable';
}

/**
 * Returns a claim token when this notice should carry the @owner mention, and
 * records the claim. Returns undefined while another session of the same bot —
 * or another bot daemon on the same CLI account — already mentioned the same
 * owner for the same limit kind in the window.
 */
export function claimRateLimitMention(input: RateLimitMentionClaimInput): number | undefined {
  const now = input.now ?? Date.now();
  for (const [key, claim] of claims) {
    if (claim.expiresAt <= now) {
      claims.delete(key);
      fileClaims.delete(claim.token);
    }
  }
  const key = `${input.larkAppId}:${input.ownerOpenId}:${input.kind}`;
  const existing = claims.get(key);
  if (existing !== undefined && existing.expiresAt > now) return undefined;
  const untilReset = Number.isFinite(input.retryAtMs) ? input.retryAtMs : now;
  const expiresAt = Math.min(
    now + RATE_LIMIT_MENTION_MAX_WINDOW_MS,
    Math.max(now + RATE_LIMIT_MENTION_MIN_WINDOW_MS, untilReset),
  );

  let fileClaim: { path: string; token: string } | undefined;
  if (input.accountKey && input.ownerUnionId) {
    const crossProcess = claimCrossProcess({
      accountKey: input.accountKey,
      ownerUnionId: input.ownerUnionId,
      kind: input.kind,
      larkAppId: input.larkAppId,
      expiresAt,
      now,
    });
    if (crossProcess === 'denied') return undefined;
    if (crossProcess !== 'unavailable') fileClaim = crossProcess;
  }

  const token = ++nextToken;
  claims.set(key, { expiresAt, token });
  if (fileClaim) fileClaims.set(token, fileClaim);
  return token;
}

/** Give the claim back when the @ notice could not be delivered, so the next
 *  limited session (or the next bot daemon on the same account) can still
 *  reach the owner. Only the claim identified by `token` is released; a newer
 *  claim is left alone, and the file is deleted only while it still holds our
 *  own token. */
export function releaseRateLimitMention(input: {
  larkAppId: string;
  ownerOpenId: string;
  kind: RateLimitMentionKind;
  token: number;
}): void {
  const key = `${input.larkAppId}:${input.ownerOpenId}:${input.kind}`;
  if (claims.get(key)?.token === input.token) claims.delete(key);
  const fileClaim = fileClaims.get(input.token);
  if (!fileClaim) return;
  fileClaims.delete(input.token);
  const current = readClaimFile(fileClaim.path);
  if (current.kind === 'ok' && current.contents?.token === fileClaim.token) {
    try { unlinkSync(fileClaim.path); } catch { /* already gone */ }
  }
}

export function __testOnly_resetRateLimitMentions(): void {
  claims.clear();
  fileClaims.clear();
}
