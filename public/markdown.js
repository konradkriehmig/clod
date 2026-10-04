// Tiny, dependency-free Markdown renderer. Escapes all HTML first, so model output can't inject markup.
(function () {
  const escapeHtml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function renderMath(tex, display) {
    if (!window.katex) return escapeHtml(display ? `$$${tex}$$` : `$${tex}$`);
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: "htmlAndMathml" });
    } catch {
      return escapeHtml(tex);
    }
  }

  // Inline code and math are swapped out for placeholders first, so markdown rules don't mangle them.
  const MATH_INLINE =
    /\$\$([^$]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?![\s$])([^$\n]*?[^\s\\$])\$(?![\d$])/g;

  function inline(text) {
    const slots = [];
    const stash = (html) => `\u0000${slots.push(html) - 1}\u0000`;
    let s = text
      .replace(/`([^`\n]+)`/g, (_, c) => stash(`<code>${escapeHtml(c)}</code>`))
      .replace(MATH_INLINE, (_, dd, br, pa, d) =>
        stash(dd != null || br != null ? renderMath((dd ?? br).trim(), true) : renderMath((pa ?? d).trim(), false)),
      );
    s = escapeHtml(s)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, "<strong>$1</strong>")
      .replace(/__(?=\S)([\s\S]+?)(?<=\S)__(?!\w)/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*(?=[^*\s])([\s\S]*?[^*\s])\*(?![*\w])/g, "$1<em>$2</em>")
      .replace(/(^|[^_\w])_(?=[^_\s])([\s\S]*?[^_\s])_(?!\w)/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[i]);
  }

  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const splitRow = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  function blocks(text) {
    const lines = text.split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      let m;
      if (/^\s*(\$\$|\\\[)/.test(line) && !/^\s*(\$\$[^$]+\$\$|\\\[.+\\\])\s*$/.test(line)) {
        // Multi-line display math: $$ ... $$ or \[ ... \]
        const close = /^\s*\$\$/.test(line) ? "$$" : "\\]";
        const buf = [line.trim().slice(2)];
        i++;
        while (i < lines.length && !lines[i].includes(close)) buf.push(lines[i++]);
        if (i < lines.length) buf.push(lines[i++].split(close)[0]);
        out.push(`<div class="math">${renderMath(buf.join("\n").trim(), true)}</div>`);
      } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
        i++;
      } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        out.push("<hr>");
        i++;
      } else if (/^\s*>/.test(line)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push(`<blockquote>${blocks(q.join("\n"))}</blockquote>`);
      } else if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
        out.push(
          `<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>` +
            rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
            "</tbody></table>",
        );
      } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const items = [];
        while (i < lines.length) {
          const l = lines[i];
          const item = l.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
          if (item) {
            items.push(item[2]);
          } else if (l.trim() && /^\s{2,}/.test(l) && items.length) {
            items[items.length - 1] += "\n" + l.trim();
          } else {
            break;
          }
          i++;
        }
        const tag = ordered ? "ol" : "ul";
        out.push(`<${tag}>${items.map((it) => `<li>${inline(it).replace(/\n/g, "<br>")}</li>`).join("")}</${tag}>`);
      } else {
        const p = [];
        while (
          i < lines.length &&
          lines[i].trim() &&
          !/^(#{1,6}\s|\s*>|\s*([-*+]|\d+[.)])\s+|\s*(\$\$|\\\[)\s*$)/.test(lines[i]) &&
          !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))
        ) {
          p.push(lines[i++]);
        }
        out.push(`<p>${inline(p.join("\n")).replace(/\n/g, "<br>")}</p>`);
      }
    }
    return out.join("");
  }

  function render(md) {
    const parts = [];
    const fence = /^```([\w+#.-]*)[^\n]*\n([\s\S]*?)(?:^```[ \t]*$|(?![\s\S]))/gm;
    let last = 0;
    let m;
    while ((m = fence.exec(md))) {
      parts.push(blocks(md.slice(last, m.index)));
      const lang = m[1] ? `<span class="lang">${escapeHtml(m[1])}</span>` : "";
      parts.push(
        `<pre>${lang}<button class="copy" type="button">Coppy</button><code>${escapeHtml(m[2].replace(/\n$/, ""))}</code></pre>`,
      );
      last = fence.lastIndex;
      if (m[0].length === 0) fence.lastIndex++;
    }
    parts.push(blocks(md.slice(last)));
    return parts.join("");
  }

  window.renderMarkdown = render;
})();
