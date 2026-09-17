'use strict';
/**
 * Self-contained Markdown renderer for assistant answers.
 *
 * No external dependency ships with the app, so this covers the subset that actually appears
 * in harness answers: fenced code (with a language label and copy button), inline code,
 * headings, bold/italic, links, ordered/unordered lists, blockquotes, tables, horizontal
 * rules and paragraphs. Everything is escaped first, so model output can never inject HTML.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML-escape a string. */
function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** Escape, then apply the inline span rules. */
function inline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (_match, code) => `<code class="md-code">${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, href) =>
    `<a href="#" data-external="${escapeHtml(href)}">${label}</a>`);
  // Bare URLs
  out = out.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="#" data-external="$2">$2</a>');
  return out;
}

/** Split a run of table cells. */
function splitRow(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());
}

/** Render markdown to HTML. */
function renderMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let index = 0;
  let listType = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (listType) { html.push(`</${listType}>`); listType = null; }
  };

  while (index < lines.length) {
    const line = lines[index];

    // Fenced code block
    const fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      flushParagraph(); closeList();
      const language = fence[1] || '';
      const body = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      const code = escapeHtml(body.join('\n'));
      html.push(
        `<div class="md-pre" data-lang="${escapeHtml(language)}">` +
        `<div class="md-pre-head"><span>${escapeHtml(language || 'code')}</span>` +
        `<button class="md-copy" data-copy="${escapeHtml(body.join('\n'))}">复制</button></div>` +
        `<pre><code>${code}</code></pre></div>`,
      );
      continue;
    }

    // Table
    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1] ?? '')) {
      flushParagraph(); closeList();
      const head = splitRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && /^\s*\|/.test(lines[index])) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      html.push(
        '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
        head.map((cell) => `<th>${inline(cell)}</th>`).join('') +
        '</tr></thead><tbody>' +
        rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('') +
        '</tbody></table></div>',
      );
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph(); closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
      flushParagraph(); closeList();
      html.push('<hr />');
      index += 1;
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      flushParagraph(); closeList();
      const quote = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      html.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
      continue;
    }

    // Lists
    const bullet = line.match(/^\s*([-*+])\s+(.*)$/);
    const ordered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (bullet || ordered) {
      flushParagraph();
      const wanted = bullet ? 'ul' : 'ol';
      if (listType !== wanted) { closeList(); html.push(`<${wanted}>`); listType = wanted; }
      html.push(`<li>${inline((bullet ?? ordered)[2])}</li>`);
      index += 1;
      continue;
    }

    if (!line.trim()) {
      flushParagraph(); closeList();
      index += 1;
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }

  flushParagraph(); closeList();
  return html.join('\n');
}

window.Markdown = { render: renderMarkdown, escapeHtml };
