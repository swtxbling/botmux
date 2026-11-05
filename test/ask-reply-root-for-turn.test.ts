import { describe, expect, it } from 'vitest';
import { askReplyRootForTurn, chatAskRootBelongsToSession } from '../src/core/reply-target.js';

type Ds = Parameters<typeof askReplyRootForTurn>[0];

function chatSession(extra: Record<string, unknown> = {}): Ds {
  return {
    scope: 'chat',
    chatId: 'oc_chat',
    currentReplyTarget: undefined,
    session: {
      sessionId: 's1',
      scope: 'chat',
      chatId: 'oc_chat',
      rootMessageId: 'oc_chat',
      turnReplyContexts: {
        om_turn_a: { target: { mode: 'thread', rootMessageId: 'om_topic_a' }, sourceMessageId: 'om_turn_a' },
        om_turn_b: { target: { mode: 'thread', rootMessageId: 'om_topic_b' }, sourceMessageId: 'om_turn_b' },
        om_turn_flat: { target: { mode: 'plain', chatId: 'oc_chat' }, sourceMessageId: 'om_turn_flat' },
        om_turn_quote: { target: { mode: 'quote', rootMessageId: 'om_quoted' }, sourceMessageId: 'om_turn_quote' },
      },
      ...extra,
    },
  } as unknown as Ds;
}

describe('askReplyRootForTurn (#2733)', () => {
  it('lands a chat-scope ask in the topic its own turn was frozen into', () => {
    expect(askReplyRootForTurn(chatSession(), 'om_turn_a')).toBe('om_topic_a');
  });

  it('keeps interleaved topic turns apart: a late ask from turn A does not follow turn B', () => {
    const ds = chatSession({ currentReplyTarget: { rootMessageId: 'om_topic_b', turnId: 'om_turn_b' } });
    expect(askReplyRootForTurn(ds, 'om_turn_a')).toBe('om_topic_a');
    expect(askReplyRootForTurn(ds, 'om_turn_b')).toBe('om_topic_b');
  });

  it('keeps group top-level turns at the group top level', () => {
    expect(askReplyRootForTurn(chatSession(), 'om_turn_flat')).toBeNull();
  });

  it('does not open a new topic under a quoted message for a quote-only turn', () => {
    expect(askReplyRootForTurn(chatSession(), 'om_turn_quote')).toBeNull();
  });

  it('stays at the top level when the issuing turn is unknown', () => {
    expect(askReplyRootForTurn(chatSession(), undefined)).toBeNull();
    expect(askReplyRootForTurn(chatSession(), 'om_never_seen')).toBeNull();
  });

  it('keeps thread-scope sessions on their session root', () => {
    const ds = { scope: 'thread', chatId: 'oc_chat', currentReplyTarget: undefined,
      session: { scope: 'thread', chatId: 'oc_chat', rootMessageId: 'om_session_root' } } as unknown as Ds;
    expect(askReplyRootForTurn(ds, 'om_turn_a')).toBe('om_session_root');
  });
});

describe('chatAskRootBelongsToSession (#2733 restart resume)', () => {
  it('accepts the group top level and topics frozen into this session', () => {
    const ds = chatSession();
    expect(chatAskRootBelongsToSession(ds, null)).toBe(true);
    expect(chatAskRootBelongsToSession(ds, 'om_topic_a')).toBe(true);
  });

  it('rejects a root no turn of this session was frozen into', () => {
    const ds = chatSession();
    expect(chatAskRootBelongsToSession(ds, 'om_foreign_topic')).toBe(false);
    expect(chatAskRootBelongsToSession(ds, 'om_quoted')).toBe(false);
  });
});
