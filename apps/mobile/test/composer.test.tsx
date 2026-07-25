import { describe, expect, it } from 'vitest';
import { effectiveDeliveryMode, shouldSubmitComposerShortcut } from '../src/components/Composer';

describe('Composer delivery mode', () => {
  it('uses normal automatic delivery while the task is idle', () => {
    expect(effectiveDeliveryMode(false, 'auto')).toBe('auto');
    expect(effectiveDeliveryMode(false, 'steer')).toBe('auto');
    expect(effectiveDeliveryMode(false, 'queue')).toBe('auto');
  });

  it('defaults an active task to steering instead of starting a competing turn', () => {
    expect(effectiveDeliveryMode(true, 'auto')).toBe('steer');
    expect(effectiveDeliveryMode(true, 'steer')).toBe('steer');
  });

  it('preserves an explicit next-turn queue choice while the task is active', () => {
    expect(effectiveDeliveryMode(true, 'queue')).toBe('queue');
  });
});


describe('Composer Enter behavior', () => {
  it('keeps plain Enter and IME Enter as textarea input instead of sending', () => {
    expect(shouldSubmitComposerShortcut({ key: 'Enter' })).toBe(false);
    expect(shouldSubmitComposerShortcut({ key: 'Enter', isComposing: true, ctrlKey: true })).toBe(false);
  });

  it('allows only an explicit physical-keyboard modifier shortcut', () => {
    expect(shouldSubmitComposerShortcut({ key: 'Enter', ctrlKey: true })).toBe(true);
    expect(shouldSubmitComposerShortcut({ key: 'Enter', metaKey: true })).toBe(true);
  });
});
