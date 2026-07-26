import { Fragment, memo, type ReactNode } from 'react';

interface InlineOptions {
  keyPrefix: string;
}

/**
 * Deliberately small, safe Markdown renderer for Codex turn output.
 * It produces React nodes only: HTML in model output is rendered as text.
 */
function renderInline(source: string, { keyPrefix }: InlineOptions): ReactNode[] {
  const expression = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_)/g;
  const nodes: ReactNode[] = [];
  let index = 0;
  let last = 0;
  for (const match of source.matchAll(expression)) {
    const position = match.index ?? 0;
    if (position > last) nodes.push(source.slice(last, position));
    const key = `${keyPrefix}-${index++}`;
    if (match[2] && match[3]) {
      nodes.push(<a key={key} href={match[3]} target="_blank" rel="noreferrer">{match[2]}</a>);
    } else if (match[4]) {
      nodes.push(<code key={key}>{match[4]}</code>);
    } else if (match[5] || match[6]) {
      nodes.push(<strong key={key}>{match[5] ?? match[6]}</strong>);
    } else if (match[7] || match[8]) {
      nodes.push(<em key={key}>{match[7] ?? match[8]}</em>);
    } else {
      nodes.push(match[0]);
    }
    last = position + match[0].length;
  }
  if (last < source.length) nodes.push(source.slice(last));
  return nodes;
}

function isListLine(line: string): boolean {
  return /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line);
}

function listItemText(line: string): { ordered: boolean; text: string } {
  const ordered = /^\s*\d+[.)]\s+/.test(line);
  return { ordered, text: line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '') };
}

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let cursor = 0;
  let blockIndex = 0;

  while (cursor < lines.length) {
    const line = lines[cursor] ?? '';
    if (!line.trim()) {
      cursor += 1;
      continue;
    }

    const fence = line.match(/^```([^\s]*)\s*$/);
    if (fence) {
      const language = fence[1] || 'text';
      const code: string[] = [];
      cursor += 1;
      while (cursor < lines.length && !/^```\s*$/.test(lines[cursor] ?? '')) {
        code.push(lines[cursor] ?? '');
        cursor += 1;
      }
      if (cursor < lines.length) cursor += 1;
      blocks.push(<pre className="markdown-code" key={`block-${blockIndex++}`} data-language={language}><code>{code.join('\n')}</code></pre>);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = Math.min(4, heading[1].length);
      const text = renderInline(heading[2], { keyPrefix: `heading-${blockIndex}` });
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4';
      blocks.push(<Tag key={`block-${blockIndex++}`}>{text}</Tag>);
      cursor += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (cursor < lines.length && /^\s*>\s?/.test(lines[cursor] ?? '')) {
        quote.push((lines[cursor] ?? '').replace(/^\s*>\s?/, ''));
        cursor += 1;
      }
      blocks.push(<blockquote key={`block-${blockIndex++}`}>{renderInline(quote.join('\n'), { keyPrefix: 'quote' })}</blockquote>);
      continue;
    }

    const next = lines[cursor + 1] ?? '';
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next)) {
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      const header = cells(line);
      cursor += 2;
      const rows: string[][] = [];
      while (cursor < lines.length && lines[cursor]?.includes('|')) {
        rows.push(cells(lines[cursor] ?? ''));
        cursor += 1;
      }
      blocks.push(
        <div className="markdown-table-wrap" key={`block-${blockIndex++}`}>
          <table><thead><tr>{header.map((cell, index) => <th key={index}>{renderInline(cell, { keyPrefix: `th-${index}` })}</th>)}</tr></thead>
          <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{header.map((_, cellIndex) => <td key={cellIndex}>{renderInline(row[cellIndex] ?? '', { keyPrefix: `td-${rowIndex}-${cellIndex}` })}</td>)}</tr>)}</tbody></table>
        </div>,
      );
      continue;
    }

    if (isListLine(line)) {
      const { ordered } = listItemText(line);
      const items: string[] = [];
      while (cursor < lines.length && isListLine(lines[cursor] ?? '')) {
        items.push(listItemText(lines[cursor] ?? '').text);
        cursor += 1;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(<List key={`block-${blockIndex++}`}>{items.map((item, index) => <li key={index}>{renderInline(item, { keyPrefix: `li-${index}` })}</li>)}</List>);
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      blocks.push(<hr key={`block-${blockIndex++}`} />);
      cursor += 1;
      continue;
    }

    const paragraph: string[] = [line];
    cursor += 1;
    while (cursor < lines.length && lines[cursor]?.trim() && !/^```/.test(lines[cursor] ?? '') && !/^(#{1,4})\s+/.test(lines[cursor] ?? '') && !/^\s*>\s?/.test(lines[cursor] ?? '') && !isListLine(lines[cursor] ?? '')) {
      paragraph.push(lines[cursor] ?? '');
      cursor += 1;
    }
    blocks.push(<p key={`block-${blockIndex++}`}>{paragraph.map((row, index) => <Fragment key={index}>{index > 0 && <br />}{renderInline(row, { keyPrefix: `p-${blockIndex}-${index}` })}</Fragment>)}</p>);
  }

  return <div className="markdown-content">{blocks}</div>;
});
