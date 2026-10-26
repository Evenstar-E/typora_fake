/* ============================================================
 * find.js — 查找替换
 * 高亮用 CSS Custom Highlight API（不动 DOM，不污染撤销栈）；
 * 替换走快照历史（Wysiwyg.touch），可 Ctrl+Z 撤销。
 * ============================================================ */
(function (global) {
  'use strict';

  var editor = null;
  var bar, input, countEl, replaceInput;
  var matches = [];
  var current = -1;
  var query = '';
  var hlSupported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

  function $(sel) { return document.querySelector(sel); }

  /* ---------------- 匹配收集 ---------------- */

  function collect(q) {
    matches = [];
    if (!q) return;
    var lower = q.toLowerCase();
    var walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.textContent) return NodeFilter.FILTER_REJECT;
        var p = n.parentNode;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest('.math')) return NodeFilter.FILTER_REJECT; /* 公式内部不搜 */
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      var text = node.textContent.toLowerCase();
      var idx = 0;
      while ((idx = text.indexOf(lower, idx)) !== -1) {
        var r = document.createRange();
        r.setStart(node, idx);
        r.setEnd(node, idx + q.length);
        matches.push(r);
        idx += q.length;
      }
    }
  }

  function paint() {
    if (!hlSupported) return;
    CSS.highlights.set('ml-find', matches.length ? Reflect.construct(Highlight, matches) : new Highlight());
  }

  function updateCount() {
    countEl.textContent = matches.length ? (current + 1) + '/' + matches.length : '0/0';
  }

  function gotoMatch(i) {
    if (!matches.length) { current = -1; updateCount(); return; }
    current = ((i % matches.length) + matches.length) % matches.length;
    var r = matches[current];
    if (hlSupported) CSS.highlights.set('ml-find-current', new Highlight(r));
    var el = r.startContainer.parentElement;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    updateCount();
  }

  function search(q) {
    query = q;
    collect(q);
    paint();
    gotoMatch(0);
  }

  /* ---------------- 替换 ---------------- */

  function replaceCurrent() {
    if (current < 0 || !matches.length) return;
    var r = matches[current];
    var pos = current;
    r.deleteContents();
    r.insertNode(document.createTextNode(replaceInput.value));
    global.Wysiwyg.touch();
    search(query);
    gotoMatch(Math.min(pos, matches.length - 1));
  }

  function replaceAll() {
    if (!query) return;
    collect(query);
    /* 倒序替换，避免同文本节点内偏移失效 */
    for (var i = matches.length - 1; i >= 0; i--) {
      var r = matches[i];
      r.deleteContents();
      r.insertNode(document.createTextNode(replaceInput.value));
    }
    global.Wysiwyg.touch();
    search(query);
  }

  /* ---------------- 开关 ---------------- */

  function open() {
    bar.classList.remove('hidden');
    var sel = window.getSelection();
    if (sel.rangeCount && sel.toString() && editor.contains(sel.anchorNode)) {
      input.value = sel.toString().slice(0, 80);
    }
    search(input.value);
    input.focus();
    input.select();
  }

  function close() {
    bar.classList.add('hidden');
    matches = [];
    current = -1;
    if (hlSupported) {
      CSS.highlights.delete('ml-find');
      CSS.highlights.delete('ml-find-current');
    }
    editor.focus();
  }

  function isOpen() { return !bar.classList.contains('hidden'); }

  /* ---------------- 初始化 ---------------- */

  function init(editorEl) {
    editor = editorEl;
    bar = $('#find-bar');
    input = $('#find-input');
    countEl = $('#find-count');
    replaceInput = $('#replace-input');

    input.addEventListener('input', function () { search(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); gotoMatch(current - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); gotoMatch(current + 1); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (!(e.ctrlKey || e.metaKey)) e.stopPropagation();
    });
    replaceInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); replaceCurrent(); }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (!(e.ctrlKey || e.metaKey)) e.stopPropagation();
    });

    /* 编辑内容变化时实时刷新匹配 */
    editor.addEventListener('input', function () {
      if (isOpen() && query) {
        var pos = Math.max(current, 0);
        collect(query);
        paint();
        gotoMatch(Math.min(pos, Math.max(matches.length - 1, 0)));
      }
    });
    $('#find-next').addEventListener('click', function () { gotoMatch(current + 1); });
    $('#find-prev').addEventListener('click', function () { gotoMatch(current - 1); });
    $('#find-close').addEventListener('click', close);
    $('#find-toggle-replace').addEventListener('click', function () {
      var show = replaceInput.classList.contains('hidden');
      replaceInput.classList.toggle('hidden', !show);
      $('#replace-one').classList.toggle('hidden', !show);
      $('#replace-all').classList.toggle('hidden', !show);
      if (show) replaceInput.focus();
    });
    $('#replace-one').addEventListener('click', replaceCurrent);
    $('#replace-all').addEventListener('click', replaceAll);
  }

  global.Find = { init: init, open: open, close: close, isOpen: isOpen, search: search };
})(typeof window !== 'undefined' ? window : globalThis);
