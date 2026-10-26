/* ============================================================
 * serialize.js — HTML → Markdown（Turndown 配置）
 * 自定义规则：数学公式、原始 HTML 保留、<u>/<mark>/<sup>/<sub> 等
 * ============================================================ */
(function (global) {
  'use strict';

  /* Turndown/GFM 已经能正确处理的标签 */
  var KNOWN_TAGS = {
    P: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    UL: 1, OL: 1, LI: 1, BLOCKQUOTE: 1, PRE: 1, CODE: 1,
    A: 1, IMG: 1, STRONG: 1, B: 1, EM: 1, I: 1, DEL: 1, S: 1, STRIKE: 1,
    TABLE: 1, THEAD: 1, TBODY: 1, TFOOT: 1, TR: 1, TH: 1, TD: 1,
    HR: 1, BR: 1, INPUT: 1, FIGURE: 1, FIGCAPTION: 1
  };
  /* 未知但应按「行内原始 HTML」保留的标签 */
  var INLINE_RAW_TAGS = {
    SPAN: 1, U: 1, MARK: 1, SUP: 1, SUB: 1, ABBR: 1, KBD: 1, SAMP: 1,
    SMALL: 1, BDI: 1, BDO: 1, Q: 1, TIME: 1, WBR: 1, FONT: 1, INS: 1, CITE: 1
  };

  function isMathEl(node) {
    return node.nodeType === 1 && node.classList &&
      (node.classList.contains('math-inline') || node.classList.contains('math-block'));
  }

  function create(deps) {
    var TurndownService = deps.TurndownService;
    var gfm = deps.gfm;

    var td = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      fence: '```',
      emDelimiter: '*',
      strongDelimiter: '**',
      linkStyle: 'inlined',
      blankReplacement: function (content, node) {
        return node.isBlock ? '\n\n' : '';
      }
    });

    if (gfm) {
      td.use(gfm.tables);
      td.use(gfm.taskListItems);
    }

    /* 删除线统一用 ~~（gfm 插件默认输出单个 ~，markdown-it 无法解析） */
    td.addRule('strikethrough', {
      filter: ['del', 's', 'strike'],
      replacement: function (content) {
        return '~~' + content + '~~';
      }
    });

    /* ---------- 无属性 DIV 视为普通段落（Chrome 回车可能产生 div） ---------- */
    td.addRule('plainDivAsParagraph', {
      filter: function (node) {
        return node.nodeName === 'DIV' && node.attributes.length === 0;
      },
      replacement: function (content) {
        return '\n\n' + content + '\n\n';
      }
    });

    /* ---------- 原始 HTML 保留（块级未知标签） ---------- */
    td.addRule('keepBlockHtml', {
      filter: function (node) {
        if (node.nodeType !== 1) return false;
        if (isMathEl(node)) return false;
        var tag = node.nodeName;
        if (KNOWN_TAGS[tag]) return false;
        if (tag === 'DIV' && node.attributes.length === 0) return false; // 交给段落规则
        return !INLINE_RAW_TAGS[tag]; // 其余一律视为块级原始 HTML
      },
      replacement: function (content, node) {
        return '\n\n' + node.outerHTML + '\n\n';
      }
    });

    /* ---------- 行内原始 HTML 保留（span/u/mark/sup/sub…） ---------- */
    td.addRule('keepInlineHtml', {
      filter: function (node) {
        if (node.nodeType !== 1 || isMathEl(node)) return false;
        return !!INLINE_RAW_TAGS[node.nodeName];
      },
      replacement: function (content, node) {
        return node.outerHTML;
      }
    });

    /* ---------- 图片：优先写回 data-src（原始路径），防止显示层地址污染 ---------- */
    td.addRule('imagePreserveSrc', {
      filter: 'img',
      replacement: function (content, node) {
        var src = node.getAttribute('data-src') || node.getAttribute('src') || '';
        var alt = node.getAttribute('alt') || '';
        var title = node.getAttribute('title');
        if (!src) return '';
        return '![' + alt + '](' + src + (title ? ' "' + title + '"' : '') + ')';
      }
    });

    /* ---------- 数学公式 ---------- */
    td.addRule('mathInline', {
      filter: function (node) {
        return isMathEl(node) && node.classList.contains('math-inline');
      },
      replacement: function (content, node) {
        var latex = node.getAttribute('data-latex') || '';
        return '$' + latex + '$';
      }
    });
    td.addRule('mathBlock', {
      filter: function (node) {
        return isMathEl(node) && node.classList.contains('math-block');
      },
      replacement: function (content, node) {
        var latex = node.getAttribute('data-latex') || '';
        return '\n\n$$\n' + latex + '\n$$\n\n';
      }
    });

    /* ---------- 图片：data: URL 过长时保持原样即可 ---------- */

    function toMarkdown(input) {
      var md = td.turndown(input);
      // 清理 3 个以上连续空行
      md = md.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '') + '\n';
      // 列表标记后的多余空格规范化为一个（Turndown 默认对齐式 "-   "）
      md = md.replace(/^(\s*(?:[-*+]|\d+[.)])) {2,}/gm, '$1 ');
      // 任务列表 "- [ ]  " 双空格规范化
      md = md.replace(/^(\s*(?:[-*+]|\d+[.)]) \[[ xX]\]) {2,}/gm, '$1 ');
      return md;
    }

    return { service: td, toMarkdown: toMarkdown };
  }

  global.SerializeKit = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
