import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function declarations(selector: string): string {
  const matches = [...css.matchAll(new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]+)\\}`, 'g'))];
  return matches.map((match) => match[1]).join('\n');
}

function expectInlineBoundary(selector: string): void {
  const rule = declarations(selector);
  expect(rule, `${selector} should have a CSS rule`).not.toBe('');
  expect(rule).toMatch(/max-width:\s*100%/);
  expect(rule).toMatch(/min-width:\s*0/);
}

describe('conversation horizontal overflow constraints', () => {
  it('keeps the page and each conversation layout boundary within the viewport', () => {
    expectInlineBoundary('html, body, #root');
    expectInlineBoundary('.app-screen');
    expectInlineBoundary('.conversation-screen');
    expectInlineBoundary('.conversation-screen > *');
    expectInlineBoundary('.conversation-body');
    expectInlineBoundary('.message-stream');
    expectInlineBoundary('.message-stream-content');
    expectInlineBoundary('.message-row');
    expectInlineBoundary('.message-column,\n.role-user .message-column');
  });


  it('prevents the conversation header from shrinking over cwd and content', () => {
    const header = declarations('.conversation-top-bar');
    expect(header).toMatch(/flex:\s*0 0 auto/);
    expect(header).toMatch(/min-height:\s*68px/);
    expect(header).toMatch(/overflow:\s*hidden/);
    expect(declarations('.conversation-title')).toMatch(/display:\s*grid/);
  });

  it('allows long message content to shrink instead of widening the vertical stream', () => {
    expectInlineBoundary('.message-detail-card');
    expectInlineBoundary('.message-detail-content');
    expectInlineBoundary('.markdown-content');

    const summary = declarations('.message-detail-card > summary');
    expect(summary).toMatch(/max-width:\s*100%/);
    expect(summary).toMatch(/min-width:\s*0/);
    expect(summary).toMatch(/grid-template-columns:\s*auto auto minmax\(0,\s*1fr\) auto/);

    const messageMeta = declarations('.message-detail-card > summary .message-meta');
    expect(messageMeta).toMatch(/min-width:\s*0/);
    expect(messageMeta).toMatch(/max-width:\s*45%/);

    expect(declarations('.markdown-content a')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(declarations('.markdown-content code')).toMatch(/word-break:\s*break-word/);
  });

  it('clips only the vertical stream while preserving intentional local horizontal viewers', () => {
    const stream = declarations('.message-stream');
    expect(stream).toMatch(/overflow-x:\s*clip/);
    expect(stream).toMatch(/overflow-y:\s*auto/);

    expect(declarations('.markdown-table-wrap')).toMatch(/overflow-x:\s*auto/);
    expect(declarations('.diff-lines')).toMatch(/overflow:\s*auto/);
    expect(declarations('.attachment-strip')).toMatch(/overflow-x:\s*auto/);
    expect(declarations('.agent-strip')).toMatch(/overflow-x:\s*auto/);
  });
});
