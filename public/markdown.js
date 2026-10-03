// Tiny, dependency-free Markdown renderer. Escapes all HTML first, so model output can't inject markup.
(function () {
  const escapeHtml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function inline(text) {
    const codes = [];
    let s = escapeHtml(text).replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = s
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
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
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
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
          !/^(#{1,6}\s|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]) &&
          !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))
        ) {
          p.push(lines[i++]);
        }
        out.push(`<p>${p.map(inline).join("<br>")}</p>`);
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
        `<pre>${lang}<button class="copy" type="button">Copy</button><code>${escapeHtml(m[2].replace(/\n$/, ""))}</code></pre>`,
      );
      last = fence.lastIndex;
      if (m[0].length === 0) fence.lastIndex++;
    }
    parts.push(blocks(md.slice(last)));
    return parts.join("");
  }

  window.renderMarkdown = render;
})();
