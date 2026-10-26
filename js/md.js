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
      render: function (text) { return md.render(text); },
      renderMathHtml: function (latex, displayMode) { return renderMathHtml(katex, latex, displayMode); },
      escapeHtml: escapeHtml,
      escapeAttr: escapeAttr
    };
  }

  global.MdKit = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
