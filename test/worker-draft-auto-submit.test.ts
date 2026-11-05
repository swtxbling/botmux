/**
 * The one automatic Enter for a parked draft (submit_unconfirmed recovery).
 *
 * The decision lives in `shouldAutoSubmitParkedDraft`; this suite drives the
 * real `autoSubmitParkedDraftStep` from src/worker.ts (loaded through the
 * worker-function harness, so no worker process is started) and proves the
 * action: which backend method is used, that a refusal still spends the one
 * Enter, and that only composer-bounded evidence can trigger it.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { shouldAutoSubmitParkedDraft } from '../src/services/submit-failure-diagnosis.js';

type StepResult = 'sent' | 'refused' | 'skipped';
type Step = (state: {
  diagnosis: { reason: string; matched?: string };
  backendType?: string;
  backend: { sendSpecialKeys?: (...keys: string[]) => boolean; write?: (data: string) => void } | undefined;
  alreadyAutoSubmitted: boolean;
  msSinceLastAutoSubmit?: number;
}) => StepResult;

const loadStep = (): Step => loadWorkerFunction<Step>('autoSubmitParkedDraftStep', {
  shouldAutoSubmitParkedDraft,
});

const composerDiagnosis = { reason: 'draft_parked', matched: 'draft_parked:claude_composer' };

describe('autoSubmitParkedDraftStep', () => {
  it('presses Enter once through sendSpecialKeys when the bot payload is parked', () => {
    const sendSpecialKeys = vi.fn(() => true);
    const step = loadStep();
    expect(step({
      diagnosis: composerDiagnosis,
      backendType: 'tmux',
      backend: { sendSpecialKeys },
      alreadyAutoSubmitted: false,
    })).toBe('sent');
    expect(sendSpecialKeys).toHaveBeenCalledTimes(1);
    expect(sendSpecialKeys).toHaveBeenCalledWith('Enter');
  });

  it('falls back to a raw carriage return on backends without key support', () => {
    const write = vi.fn();
    const step = loadStep();
    expect(step({
      diagnosis: composerDiagnosis,
      backendType: 'pty',
      backend: { write },
      alreadyAutoSubmitted: false,
    })).toBe('sent');
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('\r');
  });

  it('never presses a second Enter in the same submit chain', () => {
    const sendSpecialKeys = vi.fn(() => true);
    const step = loadStep();
    expect(step({
      diagnosis: composerDiagnosis,
      backendType: 'tmux',
      backend: { sendSpecialKeys },
      alreadyAutoSubmitted: true,
    })).toBe('skipped');
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('reports a refused keypress as refused, so the caller still spends the Enter', () => {
    const sendSpecialKeys = vi.fn(() => false);
    const step = loadStep();
    expect(step({
      diagnosis: composerDiagnosis,
      backendType: 'tmux',
      backend: { sendSpecialKeys },
      alreadyAutoSubmitted: false,
    })).toBe('refused');
  });

  it('never trusts a Claude paste chip that could be a human paste', () => {
    const sendSpecialKeys = vi.fn(() => true);
    const step = loadStep();
    expect(step({
      diagnosis: { reason: 'draft_parked', matched: 'draft_parked:claude_pasted_chip' },
      backendType: 'tmux',
      backend: { sendSpecialKeys },
      alreadyAutoSubmitted: false,
    })).toBe('skipped');
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('never acts on screen-wide draft evidence or a non-draft diagnosis', () => {
    const sendSpecialKeys = vi.fn(() => true);
    const step = loadStep();
    for (const diagnosis of [
      { reason: 'draft_parked', matched: 'draft_parked:pasted_content' },
      { reason: 'logged_out', matched: undefined },
      { reason: 'still_active', matched: undefined },
    ]) {
      expect(step({
        diagnosis: diagnosis as any,
        backendType: 'tmux',
        backend: { sendSpecialKeys },
        alreadyAutoSubmitted: false,
      })).toBe('skipped');
    }
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('respects the pane cooldown shared by overlapping submit chains', () => {
    const sendSpecialKeys = vi.fn(() => true);
    const step = loadStep();
    expect(step({
      diagnosis: composerDiagnosis,
      backendType: 'tmux',
      backend: { sendSpecialKeys },
      alreadyAutoSubmitted: false,
      msSinceLastAutoSubmit: 2_000,
    })).toBe('skipped');
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('never presses Enter on ZMX, whose screen history is not a live view', () => {
    const sendSpecialKeys = vi.fn(() => true);
    const step = loadStep();
    expect(step({
      diagnosis: composerDiagnosis,
      backendType: 'zmx',
      backend: { sendSpecialKeys },
      alreadyAutoSubmitted: false,
    })).toBe('skipped');
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });
});
