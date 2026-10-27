/* ============================================================
 * md.js — Markdown 渲染管线
 * markdown-it + KaTeX（$...$ / $$...$$）+ highlight.js
 * 以依赖注入方式构建，浏览器与 Node 测试环境均可使用。
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------- KaTeX 渲染（带错误兜底） ---------- */
  function renderMathHtml(katex, latex, displayMode) {
    var escaped = escapeAttr(latex);
    try {
      var html = katex.renderToString(latex, {
        displayMode: displayMode,
        throwOnError: true,
        output: 'html',
        strict: 'ignore'
      });
      var cls = displayMode ? 'math math-block' : 'math math-inline';
      return '<span class="' + cls + '" data-latex="' + escaped + '" contenteditable="false">' + html + '</span>';
    } catch (err) {
      var cls2 = displayMode ? 'math math-block math-error' : 'math math-inline math-error';
      return '<span class="' + cls2 + '" data-latex="' + escaped + '" contenteditable="false" title="' +
        escapeAttr(String(err && err.message || err)) + '">' + escapeHtml(latex) + '</span>';
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
  }

  /* ---------- 行内数学 $...$ ---------- */
  function mathInlineRule(katex) {
    return function mathInline(state, silent) {
      var start = state.pos;
      if (state.src.charCodeAt(start) !== 0x24 /* $ */) return false;
      // $$ 由块级规则处理；行内不接收紧跟 $ 或空格
      if (state.src[start + 1] === '$') return false;
      var match = /^\$((?:\\.|[^$\\\n])+?)\$/.exec(state.src.slice(start));
      if (!match) return false;
      var latex = match[1];
      // 开头结尾不能是空格（标准 markdown 数学约定）
      if (/^\s|\s$/.test(latex)) return false;
      if (!silent) {
        var token = state.push('math_inline', 'math', 0);
        token.content = latex;
        token.markup = '$';
      }
      state.pos += match[0].length;
      return true;
    };
  }

  /* ---------- 块级数学 $$...$$ ---------- */
  function mathBlockRule(state, startLine, endLine, silent) {
    var start = state.bMarks[startLine] + state.tShift[startLine];
    var max = state.eMarks[startLine];
    if (state.src.slice(start, start + 2) !== '$$') return false;

    var pos = start + 2;
    var firstLine = state.src.slice(pos, max);
    var latex = '';
    var nextLine = startLine;
    var found = false;

    // 单行形式：$$ ... $$
    var inlineEnd = firstLine.lastIndexOf('$$');
    if (firstLine.trim().length >= 2 && inlineEnd >= firstLine.trimEnd().length - 2 && firstLine.trim() !== '$$') {
      latex = firstLine.slice(0, firstLine.trimEnd().length - 2).trim();
      found = true;
      nextLine = startLine + 1;
    } else {
      // 多行形式
      latex = firstLine ? firstLine + '\n' : '';
      for (var line = startLine + 1; line < endLine; line++) {
        var lStart = state.bMarks[line] + state.tShift[line];
        var lMax = state.eMarks[line];
        var text = state.src.slice(lStart, lMax);
        if (text.trim() === '$$') {
          found = true;
          nextLine = line + 1;
          break;
        }
        latex += text + '\n';
      }
      if (!found) return false;
      latex = latex.trim();
    }

    if (silent) return true;
    state.line = nextLine;
    var token = state.push('math_block', 'math', 0);
    token.block = true;
    token.content = latex;
    token.map = [startLine, nextLine];
    token.markup = '$$';
    return true;
  }

  /* ---------- 代码高亮 ---------- */
  function makeHighlight(hljs) {
    return function highlightCode(str, lang) {
      var esc = str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      if (lang && hljs && hljs.getLanguage && hljs.getLanguage(lang)) {
        try {
          var val = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
          return '<pre data-lang="' + escapeAttr(lang) + '"><code class="hljs language-' + escapeAttr(lang) + '">' + val + '</code></pre>';
        } catch (e) { /* fallthrough */ }
      }
      var cls = lang ? ' class="language-' + escapeAttr(lang) + '"' : '';
      var dl = lang ? ' data-lang="' + escapeAttr(lang) + '"' : '';
      return '<pre' + dl + '><code' + cls + '>' + esc + '</code></pre>';
    };
  }

  /* ---------- 任务列表 - [ ] / - [x] ---------- */
  function findParentList(tokens, index) {
    var targetLevel = tokens[index].level - 1;
    for (var i = index - 1; i >= 0; i--) {
      if (tokens[i].level === targetLevel) return tokens[i];
    }
    return null;
  }

  function taskListsRule(state) {
    var tokens = state.tokens;
    for (var i = 2; i < tokens.length; i++) {
      if (tokens[i].type !== 'inline') continue;
      if (tokens[i - 1].type !== 'paragraph_open') continue;
      if (tokens[i - 2].type !== 'list_item_open') continue;

      var inline = tokens[i];
      var first = inline.children && inline.children[0];
      if (!first || first.type !== 'text') continue;
      var m = first.content.match(/^\[( |x|X)\]\s+/);
      if (!m) continue;

      var checked = m[1].toLowerCase() === 'x';
      first.content = first.content.slice(m[0].length);
      if (!first.content) inline.children.shift();

      tokens[i - 2].attrJoin('class', 'task-list-item');
      var listToken = findParentList(tokens, i - 2);
      if (listToken) listToken.attrJoin('class', 'contains-task-list');

      var cb = new state.Token('html_inline', '', 0);
      cb.content = '<input class="task-list-item-checkbox" type="checkbox"' +
        (checked ? ' checked' : '') + '> ';
      inline.children.unshift(cb);
    }
  }

  /* ---------- 宽容表格预处理（PDF 转换的 md 常缺分隔行） ----------
   * PDF→Markdown 转换（如 SLAM Handbook）产生的表格有两类损伤：
   *  1. 没有 | --- | 分隔行 → 标准 GFM 直接拒绝渲染（Obsidian 会自动补）
   *  2. 分隔行/空单元格用 em-dash（—）占位 → GFM 不认 em-dash 为分隔符
   * 解析前做宽容修复：识别连续管道行块，补齐/规范化分隔行；
   * 代码块（围栏/缩进）、列表、引用内的管道一律不动。
   */
  var TABLE_SKIP_RE = /^\s*(?:[>*+-]\s|\d+[.)]\s)/; // 引用/列表行不参与表格块（须后跟空格，避免误伤 "25.0% | ..."）

  function isFence(line) {
    return /^\s{0,3}(```|~~~)/.test(line);
  }

  function isPipeRow(line) {
    var t = line.trim();
    if (t.indexOf('|') === -1 || t.length > 2000) return false;
    if (TABLE_SKIP_RE.test(line)) return false;
    if (/^ {4}/.test(line)) return false; // 缩进代码块
    var pipes = (t.match(/\|/g) || []).length;
    return pipes >= 2 || /^\|/.test(t) || /\|$/.test(t);
  }

  /* 按管道切分单元格，跳过 \| 转义（表格内行内代码含竖线的标准写法） */
  function splitCells(line) {
    var t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    var cells = [];
    var cur = '';
    for (var i = 0; i < t.length; i++) {
      if (t[i] === '\\' && t[i + 1] === '|') {
        cur += '\\|';
        i++;
      } else if (t[i] === '|') {
        cells.push(cur);
        cur = '';
      } else {
        cur += t[i];
      }
    }
    cells.push(cur);
    return cells;
  }

  /* 纯 ASCII 分隔行（--- / :--: 等合法 GFM 分隔符） */
  function isAsciiDivider(line) {
    var cells = splitCells(line);
    return cells.length >= 1 && cells.every(function (c) {
      return /^:?-+:?$/.test(c.trim());
    });
  }

  /* em-dash 占位行（PDF 转换产物）：所有单元格都是 —/–（可带 : 对齐）且 ≥2 列 */
  function isEmDashDivider(line) {
    var cells = splitCells(line);
    if (cells.length < 2) return false;
    return cells.every(function (c) {
      return /^:?—+:?$/.test(c.trim()) || /^:?–+:?$/.test(c.trim());
    });
  }

  function isDividerRow(line) {
    return isAsciiDivider(line) || isEmDashDivider(line);
  }

  /* 把 em-dash 分隔行规范化为合法 GFM 分隔行（保持列数） */
  function normalizeDivider(line) {
    var n = splitCells(line).length;
    return '|' + new Array(n).fill(' --- ').join('|') + '|';
  }

  function colCount(line) {
    return splitCells(line).length;
  }

  /* PDF 断行拼接：块内不以 | 开头的行（如 "0.139 || Killian..."）是上一行的续行。
   * PDF→md 转换按页宽折行，把表格行拦腰截断；GFM 要求列数严格一致，
   * 断行直接导致整表被拒。拼接后各行列数恢复一致。 */
  function joinWrappedRows(block) {
    var joined = [block[0]];
    for (var i = 1; i < block.length; i++) {
      var t = block[i].trim();
      if (/^\|/.test(t) || isDividerRow(block[i])) {
        joined.push(block[i]);
      } else {
        /* 续行：拼到上一行末尾（PDF 断行不产生空格，行尾已有 `|`） */
        joined[joined.length - 1] = joined[joined.length - 1].replace(/\s+$/, '') + ' ' + t;
      }
    }
    return joined;
  }

  /* PDF "片式"表格修复（第三阶段）：
   * SLAM Handbook 这类转换器把表头切成多片（每片无前导管道，
   * 如 "25.0% | 稠密 GLC"），再把 em-dash 分隔行 + 全部数据行压进最后一片。
   * 识别特征：块内某行含 em-dash 分隔段，且其前的片都不以 | 开头。
   * 修复：以 em-dash 段为锚 → 锚前各片拼成一行表头；
   * 锚后按 "| |"（空单元格边界）切成数据行。 */
  function fixFragmentedTable(block) {
    /* 找到含 em-dash 分隔段且前面有 ≥2 片的行 */
    var anchorIdx = -1;
    for (var i = 1; i < block.length; i++) {
      if (/\|\s*[—–]\s*\|/.test(block[i])) { anchorIdx = i; break; }
    }
    if (anchorIdx === -1) return null;

    /* 锚行 = 表头尾片 + (可能的悬空 |) + em-dash 段 + 数据段 */
    var anchor = block[anchorIdx];
    var dashStart = anchor.indexOf('—') !== -1 ? anchor.indexOf('—') : anchor.indexOf('–');
    if (dashStart === -1) return null;
    /* em-dash 段从其前最近的管道起，到最后一个 em-dash 后的管道止 */
    var segStart = anchor.lastIndexOf('|', dashStart);
    if (segStart === -1) return null;
    var dashEnd = anchor.lastIndexOf('—') !== -1 ? anchor.lastIndexOf('—') : anchor.lastIndexOf('–');
    var segEnd = anchor.indexOf('|', dashEnd);
    if (segEnd === -1) return null;
    var headTail = anchor.slice(0, segStart);   /* 表头尾片（如 "87.5% "） */
    var dashPart = anchor.slice(segStart, segEnd + 1); /* em-dash 分隔段 */
    var rest = anchor.slice(segEnd + 1);        /* 数据段 */

    /* 锚前所有片（含锚行头部尾片）拼成表头。
     * 每片 = 一列；片内管道是 PDF 表头单元格换行（如 "25.0% | 稠密 GLC"），
     * 换成空格保持单元格内文字。 */
    var headFrags = block.slice(0, anchorIdx).map(function (s) {
      return s.trim().replace(/^\|/, '').replace(/\|$/, '').trim().replace(/\|/g, ' ');
    });
    if (headTail.trim()) {
      headFrags.push(headTail.trim().replace(/\|+$/, '').replace(/\|/g, ' ').trim());
    }
    if (headFrags.length < 2) return null;
    var header = '|' + headFrags.join('|') + '|';
    var target = headFrags.length;

    /* em-dash 段只是 PDF 装饰，列数不可信：按表头列数生成规范分隔行 */
    var divider = '|' + new Array(target).fill(' --- ').join('|') + '|';

    /* 数据段按 "| |"（空单元格 = 行分界）切开；首尾补齐管道 */
    var restNorm = rest.trim();
    if (!/^\|/.test(restNorm)) restNorm = '|' + restNorm;
    if (!/\|$/.test(restNorm)) restNorm = restNorm + '|';
    var bodyRows = restNorm.split(/\|\s*\|/).map(function (s) {
      s = s.trim().replace(/^\|/, '').replace(/\|$/, '').trim();
      if (!s) return null;
      return s;
    }).filter(Boolean);
    if (!bodyRows.length) return null;

    var fixed = [header, divider];
    for (var r = 0; r < bodyRows.length; r++) {
      /* 数据行内管道是真实列分隔；单元格可能含空段（PDF 装饰），清理纯装饰段 */
      var cells = bodyRows[r].split('|').map(function (c) { return c.trim(); });
      /* 首尾空段来自补齐的管道，去掉 */
      if (cells.length && cells[0] === '') cells.shift();
      if (cells.length && cells[cells.length - 1] === '') cells.pop();
      while (cells.length < target) cells.push('');
      cells = cells.slice(0, target);
      fixed.push('|' + cells.join('|') + '|');
    }
    return fixed;
  }

  function preprocessTables(src) {
    var lines = src.split(/\r?\n/);
    var out = [];
    var i = 0;
    var inFence = false;
    while (i < lines.length) {
      var line = lines[i];
      if (isFence(line)) {
        inFence = !inFence;
        out.push(line);
        i++;
        continue;
      }
      if (inFence || !isPipeRow(line) || isAsciiDivider(line)) {
        out.push(line);
        i++;
        continue;
      }

      /* 收集连续管道行块。
       * isPipeRowLoose：片式表头的每片可能只有 1 个管道（"25.0% | 稠密 GLC"），
       * 进入块收集后放宽为"行内含管道即可"，仍排除围栏/列表/缩进代码。 */
      function isPipeRowLoose(ln) {
        var t = ln.trim();
        if (t.indexOf('|') === -1 || t.length > 2000) return false;
        if (TABLE_SKIP_RE.test(ln)) return false;
        if (/^ {4}/.test(ln)) return false;
        return true;
      }
      var block = [line];
      var j = i + 1;
      while (j < lines.length && !isFence(lines[j]) && isPipeRowLoose(lines[j])) {
        block.push(lines[j]);
        j++;
      }

      /* 定位分隔行（ASCII 或 em-dash） */
      var divIdx = -1;
      for (var k = 0; k < block.length; k++) {
        if (isDividerRow(block[k])) { divIdx = k; break; }
      }

      /* PDF "片式"结构优先（必须在断行拼接前：片式表头每片都无前导管道，
       * join 会把它们错误地拼进上一行导致块只剩 1 行） */
      var fragFixed = (block.length >= 3) ? fixFragmentedTable(block) : null;
      if (fragFixed) {
        for (var ff = 0; ff < fragFixed.length; ff++) out.push(fragFixed[ff]);
        i = j;
        continue;
      }

      /* PDF 断行拼接：无前导管道的行并回上一行（分隔行不动） */
      block = joinWrappedRows(block);
      divIdx = -1;
      for (var k2 = 0; k2 < block.length; k2++) {
        if (isDividerRow(block[k2])) { divIdx = k2; break; }
      }

      /* 列数对齐：GFM 要求表头/分隔/每行数据列数严格一致，多列或少列整表被拒。
       * 按块内最大列数统一：不足补空单元格，超出截断（Obsidian 行为）。 */
      var target = 0;
      for (var ca = 0; ca < block.length; ca++) {
        target = Math.max(target, colCount(block[ca]));
      }
      for (var cb = 0; cb < block.length; cb++) {
        var n2 = colCount(block[cb]);
        if (n2 === target) continue;
        var cells2 = splitCells(block[cb]);
        var hadLead = /^\s*\|/.test(block[cb]);
        var hadTrail = /\|\s*$/.test(block[cb]);
        while (cells2.length < target) cells2.push('');
        cells2 = cells2.slice(0, target);
        block[cb] = (hadLead ? '|' : '') + cells2.join('|') + (hadTrail ? '|' : '');
        if (!hadLead) block[cb] = '|' + block[cb];
        if (!hadTrail) block[cb] = block[cb] + '|';
      }

      /* PDF "片式"结构优先：锚前多片表头 + 锚内压扁数据 */
      var fragFixed = (block.length >= 3) ? fixFragmentedTable(block) : null;
      if (fragFixed) {
        for (var ff = 0; ff < fragFixed.length; ff++) out.push(fragFixed[ff]);
        i = j;
        continue;
      }

      if (divIdx === -1 && block.length >= 2) {
        /* 缺分隔行：按块内最大列数补一个（保留宽行的全部数据） */
        var maxCols = 0;
        for (var m = 0; m < block.length; m++) {
          maxCols = Math.max(maxCols, colCount(block[m]));
        }
        out.push(block[0]);
        out.push('|' + new Array(maxCols).fill(' --- ').join('|') + '|');
        for (var m2 = 1; m2 < block.length; m2++) out.push(block[m2]);
      } else if (divIdx === 1) {
        /* 表头 + 分隔行结构：先表头，再（规范化后的）分隔行，再表体 */
        out.push(block[0]);
        out.push(isEmDashDivider(block[1]) ? normalizeDivider(block[1]) : block[1]);
        for (var m3 = 2; m3 < block.length; m3++) out.push(block[m3]);
      } else if (divIdx > 1) {
        /* 分隔行前有多行：分隔行紧邻的上一行作表头，更前的行保留为普通文字 */
        for (var m4 = 0; m4 < divIdx - 1; m4++) out.push(block[m4]);
        out.push(block[divIdx - 1]);
        out.push(isEmDashDivider(block[divIdx]) ? normalizeDivider(block[divIdx]) : block[divIdx]);
        for (var m5 = divIdx + 1; m5 < block.length; m5++) out.push(block[m5]);
      } else {
        /* divIdx===0（首行即分隔行）或单行块：原样不动 */
        for (var m6 = 0; m6 < block.length; m6++) out.push(block[m6]);
      }
      i = j;
    }
    return out.join('\n');
  }

  /* ---------- 构建 markdown-it 实例 ---------- */
  function create(deps) {
    var markdownit = deps.markdownit;
    var katex = deps.katex;
    var hljs = deps.hljs;

    var md = markdownit({
      html: true,        // 支持内嵌 HTML
      linkify: true,
      typographer: true,
      breaks: false,
      highlight: makeHighlight(hljs)
    });

    md.inline.ruler.after('escape', 'math_inline', mathInlineRule(katex));
    md.block.ruler.before('fence', 'math_block', mathBlockRule, {
      alt: ['paragraph', 'reference', 'blockquote', 'list']
    });
    md.core.ruler.after('inline', 'task-lists', taskListsRule);

    md.renderer.rules.math_inline = function (tokens, idx) {
      return renderMathHtml(katex, tokens[idx].content, false);
    };
    md.renderer.rules.math_block = function (tokens, idx) {
      return renderMathHtml(katex, tokens[idx].content, true) + '\n';
    };

    return {
      md: md,
      render: function (text) { return md.render(preprocessTables(text || '')); },
      renderMathHtml: function (latex, displayMode) { return renderMathHtml(katex, latex, displayMode); },
      escapeHtml: escapeHtml,
      escapeAttr: escapeAttr
    };
  }

  global.MdKit = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
