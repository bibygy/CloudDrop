// Safe zero-dependency Markdown renderer + syntax highlighter + URL extractor

import { ICONS } from './icons.js';

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;

export function extractUrls(text) {
  if (!text) return [];
  const matches = text.match(URL_RE) || [];
  const seen = new Set();
  const out = [];
  for (const raw of matches) {
    const cleaned = raw.replace(/[.,;:!?]+$/, '');
    if (seen.has(cleaned)) continue;
    try {
      const u = new URL(cleaned);
      seen.add(cleaned);
      out.push({ url: u.href, host: u.hostname, path: u.pathname + u.search });
    } catch {
      // ignore invalid URL
    }
  }
  return out;
}

export function extractTags(text) {
  if (!text) return [];
  const found = new Set();
  const re = /(?:^|\s)#([\p{L}\p{N}_-]{1,24})/gu;
  let m;
  while ((m = re.exec(text)) !== null) {
    found.add(m[1]);
  }
  return [...found];
}

// Single-pass syntax highlighter (runs on HTML-escaped code so tokens never collide)
const CODE_TOKEN_RE = new RegExp(
  [
    '(?<cmt>\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*|(?<=^|[ \\t])#[^\\n]*)',
    '(?<str>&quot;(?:\\\\.|[^&]|&(?!quot;))*?&quot;|&#39;(?:\\\\.|[^&]|&(?!#39;))*?&#39;|`[\\s\\S]*?`)',
    '(?<kw>\\b(?:const|let|var|function|return|async|await|import|export|from|default|class|extends|new|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|def|elif|pass|with|as|lambda|yield|pub|fn|struct|enum|impl|match|use|mod|mut|ref|true|false|null|None|True|False|undefined|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|TABLE|JOIN|ORDER|BY|GROUP)\\b)',
    '(?<num>\\b\\d+(?:\\.\\d+)?\\b)',
    '(?<fn>\\b[a-zA-Z_][\\w]*(?=\\s*\\())'
  ].join('|'),
  'gm'
);

function highlightCode(rawCode) {
  const escaped = escapeHtml(rawCode);
  return escaped.replace(CODE_TOKEN_RE, (match, ...args) => {
    const groups = args[args.length - 1];
    if (groups.cmt !== undefined) return `<span class="tok-cmt">${match}</span>`;
    if (groups.str !== undefined) return `<span class="tok-str">${match}</span>`;
    if (groups.kw !== undefined) return `<span class="tok-kw">${match}</span>`;
    if (groups.num !== undefined) return `<span class="tok-num">${match}</span>`;
    if (groups.fn !== undefined) return `<span class="tok-fn">${match}</span>`;
    return match;
  });
}

function renderInline(text) {
  const codeSlots = [];
  let s = escapeHtml(text);

  // Protect inline code first
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = codeSlots.length;
    codeSlots.push(`<code class="inline-code">${code}</code>`);
    return `\u0001${idx}\u0001`;
  });

  // Markdown links [label](https://...)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // Bare URLs (not already inside href="...")
  s = s.replace(/(^|[\s(>])(https?:\/\/[^\s<>"'`)\]]+)/g, (full, pre, rawUrl) => {
    const clean = rawUrl.replace(/[.,;:!?]+$/, '');
    const trailing = rawUrl.slice(clean.length);
    return `${pre}<a href="${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>${trailing}`;
  });

  // Bold, italic, strikethrough
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  return s.replace(/\u0001(\d+)\u0001/g, (_, i) => codeSlots[Number(i)]);
}

export function renderMarkdown(source) {
  if (!source || !source.trim()) return '';

  // Extract fenced code blocks first
  const blocks = [];
  const withPlaceholders = source.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = blocks.length;
    const cleanCode = code.replace(/\n$/, '');
    const encoded = encodeURIComponent(cleanCode);
    const label = lang ? escapeHtml(lang) : 'code';
    blocks.push(
      `<div class="code-block">` +
        `<div class="code-block-header">` +
          `<span class="code-lang">${label}</span>` +
          `<button class="code-copy-btn" type="button" data-copy-code="${encoded}">${ICONS.copy}<span>复制</span></button>` +
        `</div>` +
        `<pre><code>${highlightCode(cleanCode)}</code></pre>` +
      `</div>`
    );
    return `\n\u0002BLOCK_${idx}\u0002\n`;
  });

  const lines = withPlaceholders.split(/\r?\n/);
  const html = [];
  let inUl = false;
  let inOl = false;
  let paraLines = [];

  const flushPara = () => {
    if (paraLines.length) {
      html.push(`<p>${paraLines.map(renderInline).join('<br>')}</p>`);
      paraLines = [];
    }
  };
  const closeLists = () => {
    if (inUl) { html.push('</ul>'); inUl = false; }
    if (inOl) { html.push('</ol>'); inOl = false; }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    const blockMatch = trimmed.match(/^\u0002BLOCK_(\d+)\u0002$/);
    if (blockMatch) {
      flushPara();
      closeLists();
      html.push(blocks[Number(blockMatch[1])]);
      continue;
    }

    if (!trimmed) {
      flushPara();
      closeLists();
      continue;
    }

    // Headings
    const hMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (hMatch) {
      flushPara();
      closeLists();
      const lvl = hMatch[1].length;
      html.push(`<h${lvl}>${renderInline(hMatch[2])}</h${lvl}>`);
      continue;
    }

    // Blockquote
    const bqMatch = line.match(/^>\s?(.*)$/);
    if (bqMatch) {
      flushPara();
      closeLists();
      html.push(`<blockquote>${renderInline(bqMatch[1])}</blockquote>`);
      continue;
    }

    // Task / Unordered list
    const ulMatch = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ulMatch) {
      flushPara();
      if (inOl) { html.push('</ol>'); inOl = false; }
      if (!inUl) { html.push('<ul>'); inUl = true; }
      let content = ulMatch[1];
      if (/^\[x\]\s+/i.test(content)) {
        content = `☑ ${renderInline(content.replace(/^\[x\]\s+/i, ''))}`;
      } else if (/^\[ \]\s+/.test(content)) {
        content = `☐ ${renderInline(content.replace(/^\[ \]\s+/, ''))}`;
      } else {
        content = renderInline(content);
      }
      html.push(`<li>${content}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (olMatch) {
      flushPara();
      if (inUl) { html.push('</ul>'); inUl = false; }
      if (!inOl) { html.push('<ol>'); inOl = true; }
      html.push(`<li>${renderInline(olMatch[1])}</li>`);
      continue;
    }

    closeLists();
    paraLines.push(line);
  }

  flushPara();
  closeLists();
  return html.join('');
}
