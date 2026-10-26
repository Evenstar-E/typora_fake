/* ============================================================
 * wysiwyg.js — 所见即所得编辑控制器
 * contenteditable + Markdown 输入快捷键 + 公式/代码块/表格交互
 * ============================================================ */
(function (global) {
  'use strict';

  var editor, mdKit, serializer, hooks = {};
  var savedRange = null;          // 浮层打开时保存的选区
  var activeMathEl = null;        // 正在编辑的公式元素
  var preHasFocus = false;

  /* ---------------- 工具函数 ---------------- */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function getSel() { return window.getSelection(); }

  function selInsideEditor() {
    var s = getSel();
    if (!s.rangeCount) return false;
    return editor.contains(s.anchorNode);
  }

  /* 最近的块级容器 */
  function currentBlock() {
    var s = getSel();
    if (!s.rangeCount || !editor.contains(s.anchorNode)) return null;
    var node = s.anchorNode.nodeType === 3 ? s.anchorNode.parentNode : s.anchorNode;
    var BLOCKS = { P: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, LI: 1, BLOCKQUOTE: 1, PRE: 1, TD: 1, TH: 1, DIV: 1 };
    while (node && node !== editor) {
      if (BLOCKS[node.nodeName]) return node;
      node = node.parentNode;
    }
    return null;
  }

  function nodeInside(node, names) {
    while (node && node !== editor) {
      if (names.indexOf(node.nodeName) !== -1) return node;
      node = node.parentNode;
    }
    return null;
  }

  function saveRange() {
    var s = getSel();
    if (s.rangeCount && editor.contains(s.anchorNode)) {
      savedRange = s.getRangeAt(0).cloneRange();
    }
  }

  function restoreRange() {
    if (!savedRange) return;
    var s = getSel();
    s.removeAllRanges();
    s.addRange(savedRange);
  }

  function placeCaretAfter(node) {
    var range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    var s = getSel();
    s.removeAllRanges();
    s.addRange(range);
  }

  function placeCaretAtStart(node) {
    var range = document.createRange();
    range.setStart(node, 0);
    range.collapse(true);
    var s = getSel();
    s.removeAllRanges();
    s.addRange(range);
  }

  /* 获取 pre 内的纯文本 caret 偏移 */
  function caretOffsetIn(root) {
    var s = getSel();
    if (!s.rangeCount) return 0;
    var range = s.getRangeAt(0);
    var pre = range.cloneRange();
    pre.selectNodeContents(root);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().length;
  }

  function setCaretOffset(root, offset) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var node, remaining = offset;
    while ((node = walker.nextNode())) {
      if (node.textContent.length >= remaining) {
        var range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        var s = getSel();
        s.removeAllRanges();
        s.addRange(range);
        return;
      }
      remaining -= node.textContent.length;
    }
    /* 没有足够文本节点时放到末尾 */
    var range2 = document.createRange();
    range2.selectNodeContents(root);
    range2.collapse(false);
    var s2 = getSel();
    s2.removeAllRanges();
    s2.addRange(range2);
  }

  function exec(cmd, arg) {
    document.execCommand(cmd, false, arg);
    emitChange();
  }

  function emitChange() {
    ensureStructure();
    schedulePush();
    if (hooks.onChange) hooks.onChange();
  }

  /* ---------------- 撤销/恢复（快照栈） ----------------
   * 浏览器原生撤销栈会被手动 DOM 操作（自动格式化、公式渲染等）清空，
   * 因此自建快照栈：存 innerHTML + 全文纯文本光标偏移。
   */
  var history = [];
  var hIndex = -1;
  var pushTimer = null;
  var restoring = false;
  var composing = false;
  var HISTORY_LIMIT = 100;

  function pushHistory() {
    clearTimeout(pushTimer);
    pushTimer = null;
    if (restoring || composing) return;
    var html = editor.innerHTML;
    if (hIndex >= 0 && history[hIndex].html === html) return; // 去重
    var caret = null;
    if (selInsideEditor()) {
      try { caret = caretOffsetIn(editor); } catch (e) {}
    }
    history = history.slice(0, hIndex + 1); // 截断"未来"分支
    history.push({ html: html, caret: caret });
    if (history.length > HISTORY_LIMIT) history.shift();
    hIndex = history.length - 1;
  }

  /* 输入变化防抖压栈：连续输入每 400ms 记一步 */
  function schedulePush() {
    if (restoring || composing) return;
    if (pushTimer) return;
    pushTimer = setTimeout(pushHistory, 400);
  }

  /* 立即压栈（命令执行前调用，保证命令前状态可回退） */
  function flushHistory() {
    if (pushTimer) pushHistory();
  }

  function resetHistory() {
    clearTimeout(pushTimer);
    pushTimer = null;
    history = [];
    hIndex = -1;
    pushHistory();
  }

  function stepHistory(dir) {
    flushHistory();
    var target = hIndex + dir;
    if (target < 0 || target >= history.length) return;
    hIndex = target;
    var snap = history[hIndex];
    restoring = true;
    editor.innerHTML = snap.html;
    postRender();
    restoring = false;
    if (snap.caret !== null && snap.caret !== undefined) {
      try { setCaretOffset(editor, snap.caret); } catch (e) {}
    }
    editor.focus();
    emitChange();
  }

  function historyUndo() { stepHistory(-1); }
  function historyRedo() { stepHistory(1); }

  /* ---------------- 结构保障 ---------------- */

  function ensureStructure() {
    if (!editor.firstChild || editor.innerHTML === '<br>') {
      editor.innerHTML = '<p><br></p>';
    }
  }

  /* ---------------- 渲染后处理 ---------------- */

  function postRender() {
    /* 空公式块占位 */
    $all('span.math-block', editor).forEach(function (el) {
      el.contentEditable = 'false';
      if (!(el.getAttribute('data-latex') || '').trim()) {
        el.innerHTML = '<span class="math-empty">双击输入 LaTeX 公式</span>';
      }
    });
    $all('span.math-inline', editor).forEach(function (el) {
      el.contentEditable = 'false';
    });
    /* 备份图片原始路径：显示层若替换 src（如 blob 解析、data URL），
     * 序列化时仍写回 data-src 中的原始路径，防止污染 .md 文件 */
    $all('img', editor).forEach(function (img) {
      if (!img.hasAttribute('data-src')) {
        img.setAttribute('data-src', img.getAttribute('src') || '');
      }
    });
    /* 末尾补一个段落方便点击 */
    var last = editor.lastElementChild;
    if (last && /^(PRE|TABLE|HR|UL|OL|BLOCKQUOTE)$/.test(last.nodeName)) {
      editor.appendChild(document.createElement('p')).innerHTML = '<br>';
    }
    ensureStructure();
    if (hooks.onPostRender) hooks.onPostRender();
  }

  /* ---------------- 对外接口 ---------------- */

  function setMarkdown(text) {
    editor.innerHTML = mdKit.render(text || '');
    postRender();
    resetHistory(); /* 新文档 = 新历史栈，撤销不跨越文件加载 */
    emitChange();
  }

  /* 在光标/选区处插入 Markdown 文本（AI 面板等用） */
  function insertMarkdown(mdText) {
    var html = mdKit.render(mdText || '');
    document.execCommand('insertHTML', false, html);
    postRender();
    emitChange();
  }

  function getMarkdown() {
    var clone = editor.cloneNode(true);
    /* 清理 UI 态 */
    $all('.selected', clone).forEach(function (el) { el.classList.remove('selected'); });
    /* 清除零宽空格（行内格式边界辅助字符） */
    var walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null);
    var tnodes = [];
    var tn;
    while ((tn = walker.nextNode())) {
      if (tn.textContent.indexOf('\u200B') !== -1) tnodes.push(tn);
    }
    tnodes.forEach(function (t) { t.textContent = t.textContent.replace(/\u200B/g, ''); });
    /* 规范 pre：确保 code 子元素 */
    $all('pre', clone).forEach(function (pre) {
      if (!pre.querySelector('code')) {
        var code = document.createElement('code');
        code.textContent = pre.textContent;
        pre.textContent = '';
        pre.appendChild(code);
      }
      pre.removeAttribute('data-focused');
    });
    return serializer.toMarkdown(clone);
  }

  /* ---------------- 行内自动格式化 ----------------
   * 输入 **x** / *x* / `x` / ~~x~~ / $x$ / [t](u) 时即时转换
   */
  var INLINE_PATTERNS = [
    { re: /\*\*([^*\n]+)\*\*$/, tag: 'strong' },
    { re: /__([^_\n]+)__$/, tag: 'strong' },
    { re: /(?<!\*)\*([^*\n]+)\*$/, tag: 'em' },
    { re: /~~([^~\n]+)~~$/, tag: 'del' },
    { re: /`([^`\n]+)`$/, tag: 'code' },
    { re: /\$([^$\n]+)\$$/, tag: 'math' },
    { re: /\[([^\]\n]+)\]\(([^)\s]+)\)$/, tag: 'link' }
  ];

  function tryInlineFormat() {
    var s = getSel();
    if (!s.isCollapsed || !s.rangeCount) return;
    var node = s.anchorNode;
    if (node.nodeType !== 3) return;
    if (nodeInside(node, ['PRE', 'CODE'])) return;
    var spanParent = nodeInside(node, ['SPAN']);
    if (spanParent && spanParent.classList.contains('math')) return;

    var offset = s.anchorOffset;
    var before = node.textContent.slice(0, offset);
    if (!before) return;

    for (var i = 0; i < INLINE_PATTERNS.length; i++) {
      var p = INLINE_PATTERNS[i];
      var m = before.match(p.re);
      if (!m) continue;

      var startOffset = offset - m[0].length;
      var range = document.createRange();
      range.setStart(node, startOffset);
      range.setEnd(node, offset);

      var newNode;
      if (p.tag === 'math') {
        var tmp = document.createElement('span');
        tmp.innerHTML = mdKit.renderMathHtml(m[1], false);
        newNode = tmp.firstChild;
      } else if (p.tag === 'link') {
        newNode = document.createElement('a');
        newNode.href = m[2];
        newNode.textContent = m[1];
      } else {
        newNode = document.createElement(p.tag);
        newNode.textContent = m[1];
      }
      range.deleteContents();
      range.insertNode(newNode);
      /* Chrome 在内联元素末尾会继续其格式：插入零宽空格作为格式边界 */
      var zwsp = document.createTextNode('\u200B');
      newNode.parentNode.insertBefore(zwsp, newNode.nextSibling);
      var caretRange = document.createRange();
      caretRange.setStart(zwsp, 1);
      caretRange.collapse(true);
      var sel2 = getSel();
      sel2.removeAllRanges();
      sel2.addRange(caretRange);
      emitChange();
      return;
    }
  }

  /* ---------------- 空格块级快捷键 ---------------- */

  function tryBlockShortcut() {
    var s = getSel();
    if (!s.isCollapsed) return;
    var block = currentBlock();
    if (!block || block.nodeName === 'PRE' || block.nodeName === 'TD' || block.nodeName === 'TH') return;
    /* 只处理文本型块 */
    if (!/^(P|DIV|H[1-6]|LI)$/.test(block.nodeName)) return;

    /* 光标前的块内文本 */
    var range = document.createRange();
    range.selectNodeContents(block);
    range.setEnd(s.anchorNode, s.anchorOffset);
    var before = range.toString();

    var m;
    /* 标题 */
    if ((m = before.match(/^(#{1,6})\s$/))) {
      replaceBlockText(block, before, 'h' + m[1].length);
      return;
    }
    /* 引用 */
    if (/^>\s$/.test(before)) {
      replaceBlockText(block, before, 'blockquote');
      return;
    }
    /* 无序列表 */
    if (/^[-*+]\s$/.test(before) && block.nodeName !== 'LI') {
      deleteBlockText(block, before);
      exec('insertUnorderedList');
      return;
    }
    /* 有序列表 */
    if (/^\d{1,2}[.)]\s$/.test(before) && block.nodeName !== 'LI') {
      deleteBlockText(block, before);
      exec('insertOrderedList');
      return;
    }
    /* 任务列表 */
    if ((m = before.match(/^(?:-\s)?\[( |x|X)\]\s$/))) {
      deleteBlockText(block, before);
      makeTaskItem(block, m[1].toLowerCase() === 'x');
      return;
    }
  }

  function deleteBlockText(block, text) {
    /* 删除块开头的触发文本 */
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    var node, remaining = text.length;
    while ((node = walker.nextNode()) && remaining > 0) {
      var cut = Math.min(node.textContent.length, remaining);
      node.textContent = node.textContent.slice(cut);
      remaining -= cut;
    }
  }

  function replaceBlockText(block, triggerText, newTag) {
    deleteBlockText(block, triggerText);
    if (!block.textContent) block.innerHTML = '<br>';
    var s = getSel();
    var r = document.createRange();
    r.selectNodeContents(block);
    r.collapse(false);
    s.removeAllRanges();
    s.addRange(r);
    exec('formatBlock', '<' + newTag + '>');
  }

  function makeTaskItem(block, checked) {
    var ul = document.createElement('ul');
    var li = document.createElement('li');
    li.className = 'task-list-item';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    li.appendChild(cb);
    li.appendChild(document.createTextNode(' '));
    var content = block.textContent;
    li.appendChild(document.createTextNode(content));
    ul.appendChild(li);
    block.parentNode.replaceChild(ul, block);
    placeCaretAtStart(li.childNodes[li.childNodes.length - 1]);
    if (li.lastChild.nodeType === 3 && !li.lastChild.textContent) placeCaretAfter(cb);
    emitChange();
  }

  /* ---------------- 回车块级快捷键 ---------------- */

  function tryEnterShortcut(e) {
    var block = currentBlock();
    if (!block || !/^(P|DIV)$/.test(block.nodeName)) return false;
    var text = block.textContent.trim();

    /* ``` 代码块 */
    var m = text.match(/^```(\w[-\w+#]*)?$/);
    if (m) {
      e.preventDefault();
      var lang = m[1] || '';
      var pre = document.createElement('pre');
      if (lang) pre.setAttribute('data-lang', lang);
      var code = document.createElement('code');
      if (lang) code.className = 'language-' + lang;
      code.innerHTML = '<br>';
      pre.appendChild(code);
      block.parentNode.replaceChild(pre, block);
      placeCaretAtStart(code);
      emitChange();
      return true;
    }
    /* $$ 公式块 */
    if (text === '$$') {
      e.preventDefault();
      var el = newMathBlock();
      block.parentNode.replaceChild(el, block);
      emitChange();
      openMathEditor(el);
      return true;
    }
    /* --- 分割线 */
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(text)) {
      e.preventDefault();
      var hr = document.createElement('hr');
      var p = document.createElement('p');
      p.innerHTML = '<br>';
      block.parentNode.replaceChild(hr, block);
      hr.parentNode.insertBefore(p, hr.nextSibling);
      placeCaretAtStart(p);
      emitChange();
      return true;
    }
    return false;
  }

  function newMathBlock() {
    var tmp = document.createElement('span');
    tmp.innerHTML = '<span class="math math-block" data-latex="" contenteditable="false"><span class="math-empty">双击输入 LaTeX 公式</span></span>';
    return tmp.firstChild;
  }

  /* ---------------- 代码块交互 ---------------- */

  function refreshPre(pre) {
    /* 失焦后重新高亮 */
    var code = pre.querySelector('code');
    var text = (code || pre).textContent.replace(/\n$/, '');
    var lang = pre.getAttribute('data-lang') || '';
    var html;
    if (lang && global.hljs && global.hljs.getLanguage(lang)) {
      try {
        html = global.hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
      } catch (e) { html = mdKit.escapeHtml(text); }
    } else {
      html = mdKit.escapeHtml(text);
    }
    var codeEl = document.createElement('code');
    codeEl.className = 'hljs' + (lang ? ' language-' + lang : '');
    codeEl.innerHTML = html || '<br>';
    pre.innerHTML = '';
    pre.appendChild(codeEl);
  }

  function dehighlightPre(pre) {
    /* 聚焦时还原为纯文本便于编辑 */
    var code = pre.querySelector('code');
    if (!code) return;
    if (code.querySelector('*')) {
      var offset = selInsideEditor() && nodeInside(getSel().anchorNode, ['PRE']) === pre ? caretOffsetIn(pre) : null;
      code.textContent = code.textContent;
      if (offset !== null) setCaretOffset(code, offset);
    }
  }

  /* ---------------- 公式编辑浮层 ---------------- */

  var mathPop, mathInput, mathPreview;

  function openMathEditor(el) {
    activeMathEl = el;
    mathPop.classList.remove('hidden');
    var rect = el.getBoundingClientRect();
    var top = Math.min(rect.bottom + 8, window.innerHeight - 260);
    var left = Math.max(12, Math.min(rect.left, window.innerWidth - 340));
    mathPop.style.top = top + 'px';
    mathPop.style.left = left + 'px';
    mathInput.value = el.getAttribute('data-latex') || '';
    updateMathPreview();
    setTimeout(function () { mathInput.focus(); }, 0);
  }

  function closeMathEditor() {
    mathPop.classList.add('hidden');
    activeMathEl = null;
  }

  function updateMathPreview() {
    var latex = mathInput.value.trim();
    if (!latex) { mathPreview.innerHTML = '<span style="color:var(--faint)">预览</span>'; return; }
    try {
      mathPreview.innerHTML = global.katex.renderToString(latex, {
        displayMode: activeMathEl && activeMathEl.classList.contains('math-block'),
        throwOnError: true
      });
    } catch (err) {
      mathPreview.innerHTML = '<span class="err">' + mdKit.escapeHtml(String(err.message || err)) + '</span>';
    }
  }

  function applyMathEdit() {
    if (!activeMathEl) return;
    var latex = mathInput.value.trim();
    var isBlock = activeMathEl.classList.contains('math-block');
    if (!latex) {
      /* 空公式 → 删除元素 */
      var parent = activeMathEl.parentNode;
      activeMathEl.remove();
      closeMathEditor();
      emitChange();
      return;
    }
    var tmp = document.createElement('span');
    tmp.innerHTML = mdKit.renderMathHtml(latex, isBlock);
    var newEl = tmp.firstChild;
    activeMathEl.parentNode.replaceChild(newEl, activeMathEl);
    closeMathEditor();
    emitChange();
  }

  function deleteMathEl() {
    if (!activeMathEl) return;
    activeMathEl.remove();
    closeMathEditor();
    emitChange();
  }

  /* ---------------- 链接 / 图片浮层 ---------------- */

  var linkPop, linkText, linkUrl;
  function openLinkEditor() {
    saveRange();
    var s = getSel();
    linkText.value = s.rangeCount ? s.getRangeAt(0).toString() : '';
    linkUrl.value = '';
    /* 若已在链接内，带出原地址 */
    var a = s.rangeCount ? nodeInside(s.anchorNode, ['A']) : null;
    if (a) { linkUrl.value = a.getAttribute('href') || ''; linkText.value = a.textContent; }
    showPop(linkPop);
    setTimeout(function () { (linkText.value ? linkUrl : linkText).focus(); }, 0);
  }
  function applyLink() {
    restoreRange();
    var text = linkText.value.trim();
    var url = linkUrl.value.trim();
    linkPop.classList.add('hidden');
    if (!url) return;
    var s = getSel();
    var existing = s.rangeCount ? nodeInside(s.anchorNode, ['A']) : null;
    if (existing) {
      existing.href = url;
      if (text) existing.textContent = text;
    } else {
      var a = document.createElement('a');
      a.href = url;
      a.textContent = text || url;
      if (s.rangeCount && !s.isCollapsed) {
        s.getRangeAt(0).deleteContents();
        s.getRangeAt(0).insertNode(a);
      } else {
        insertNodeAtCaret(a);
      }
      placeCaretAfter(a);
    }
    emitChange();
  }

  var imgPop, imgUrl, imgAlt;
  function openImageEditor() {
    saveRange();
    imgUrl.value = '';
    imgAlt.value = '';
    showPop(imgPop);
    setTimeout(function () { imgUrl.focus(); }, 0);
  }
  function insertImage(src, alt) {
    restoreRange();
    var img = document.createElement('img');
    img.src = src;
    img.alt = alt || '';
    img.title = alt || '';
    insertNodeAtCaret(img);
    emitChange();
  }

  function showPop(pop) {
    pop.classList.remove('hidden');
    pop.style.top = '80px';
    pop.style.left = Math.max(12, (window.innerWidth - 340) / 2) + 'px';
  }
  function hidePops() {
    $all('.popover').forEach(function (p) { p.classList.add('hidden'); });
    activeMathEl = null;
  }

  function insertNodeAtCaret(node) {
    var s = getSel();
    if (!s.rangeCount || !editor.contains(s.anchorNode)) {
      editor.appendChild(node);
      return;
    }
    var range = s.getRangeAt(0);
    range.deleteContents();
    range.insertNode(node);
    placeCaretAfter(node);
  }

  /* ---------------- 工具栏命令 ---------------- */

  function insertTable() {
    var table = document.createElement('table');
    var thead = table.createTHead();
    var hr = thead.insertRow();
    for (var i = 0; i < 3; i++) hr.insertCell().outerHTML = '<th>表头' + (i + 1) + '</th>';
    var tbody = table.createTBody();
    for (var r = 0; r < 2; r++) {
      var row = tbody.insertRow();
      for (var c = 0; c < 3; c++) row.insertCell().innerHTML = '<br>';
    }
    insertNodeAtCaret(table);
    var firstCell = table.querySelector('th');
    if (firstCell) placeCaretAtStart(firstCell);
    emitChange();
  }

  function toggleInlineCode() {
    var s = getSel();
    if (!s.rangeCount) return;
    var codeEl = nodeInside(s.anchorNode, ['CODE']);
    if (codeEl && codeEl.parentNode.nodeName !== 'PRE') {
      /* 取消行内代码 */
      var text = document.createTextNode(codeEl.textContent);
      codeEl.parentNode.replaceChild(text, codeEl);
      var r = document.createRange();
      r.selectNodeContents(text);
      s.removeAllRanges();
      s.addRange(r);
    } else if (!s.isCollapsed) {
      var range = s.getRangeAt(0);
      var code = document.createElement('code');
      try {
        range.surroundContents(code);
      } catch (e) {
        code.appendChild(range.extractContents());
        range.insertNode(code);
      }
      s.removeAllRanges();
      var r2 = document.createRange();
      r2.selectNodeContents(code);
      r2.collapse(false);
      s.addRange(r2);
    }
    emitChange();
  }

  function clearFormat() {
    exec('removeFormat');
    var block = currentBlock();
    if (block && /^H[1-6]$/.test(block.nodeName)) exec('formatBlock', '<p>');
  }

  var commands = {
    bold: function () { exec('bold'); },
    italic: function () { exec('italic'); },
    strikeThrough: function () { exec('strikeThrough'); },
    inlineCode: toggleInlineCode,
    clearFormat: clearFormat,
    insertUnorderedList: function () { exec('insertUnorderedList'); },
    insertOrderedList: function () { exec('insertOrderedList'); },
    undo: historyUndo,
    redo: historyRedo,
    link: openLinkEditor,
    image: openImageEditor,
    table: insertTable,
    hr: function () { exec('insertHorizontalRule'); },
    mathBlock: function () {
      var el = newMathBlock();
      insertNodeAtCaret(el);
      emitChange();
      openMathEditor(el);
    },
    taskList: function () {
      var s = getSel();
      var li = s.rangeCount ? nodeInside(s.anchorNode, ['LI']) : null;
      if (li) {
        li.classList.toggle('task-list-item');
        var cb = li.querySelector(':scope > input[type="checkbox"]');
        if (cb) { cb.remove(); }
        else {
          cb = document.createElement('input');
          cb.type = 'checkbox';
          li.insertBefore(cb, li.firstChild);
          li.insertBefore(document.createTextNode(' '), cb.nextSibling);
        }
        emitChange();
      } else {
        var block = currentBlock();
        if (block && /^(P|DIV|H[1-6])$/.test(block.nodeName)) makeTaskItem(block, false);
      }
    }
  };

  function execCommand(cmd, arg) {
    editor.focus();
    flushHistory();
    if (commands[cmd]) { commands[cmd](); return; }
    /* formatBlock 系列 */
    if (/^(p|h[1-6]|blockquote|pre)$/.test(cmd)) {
      if (cmd === 'pre') {
        var block = currentBlock();
        if (block && block.nodeName !== 'PRE') {
          var pre = document.createElement('pre');
          var code = document.createElement('code');
          code.textContent = block.textContent || '';
          pre.appendChild(code);
          block.parentNode.replaceChild(pre, block);
          placeCaretAtStart(code);
          refreshPre(pre);
          emitChange();
        }
      } else {
        exec('formatBlock', '<' + cmd + '>');
      }
    }
  }

  /* ---------------- 粘贴处理 ---------------- */

  function onPaste(e) {
    var cd = e.clipboardData;
    if (!cd) return;

    /* 图片文件 */
    if (cd.files && cd.files.length) {
      var file = cd.files[0];
      if (/^image\//.test(file.type)) {
        e.preventDefault();
        var reader = new FileReader();
        reader.onload = function () { insertImage(reader.result, file.name); };
        reader.readAsDataURL(file);
        return;
      }
    }

    var html = cd.getData('text/html');
    var text = cd.getData('text/plain');
    if (!html && !text) return;
    e.preventDefault();

    /* 纯短文本（无换行、无 Markdown 特殊字符）直接插入 */
    if (!html && text && !/[\n\r]/.test(text) && !/[\\`*_{}\[\]()#+\-.!|>$~]/.test(text)) {
      document.execCommand('insertText', false, text);
      emitChange();
      return;
    }

    var mdText;
    try {
      mdText = html ? serializer.toMarkdown(html) : text;
    } catch (err) {
      mdText = text || '';
    }
    var rendered = mdKit.render(mdText);
    document.execCommand('insertHTML', false, rendered);
    postRender();
    emitChange();
  }

  /* ---------------- 键盘事件 ---------------- */

  function onKeydown(e) {
    /* 撤销/恢复（覆盖原生，原生栈会被手动 DOM 操作清空） */
    var mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      historyUndo();
      return;
    }
    if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault();
      historyRedo();
      return;
    }

    var block = currentBlock();

    /* pre 内的 Enter / Tab / Ctrl+Enter */
    if (block && block.nodeName === 'PRE') {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        var p = document.createElement('p');
        p.innerHTML = '<br>';
        block.parentNode.insertBefore(p, block.nextSibling);
        placeCaretAtStart(p);
        emitChange();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        document.execCommand('insertText', false, '\n');
        emitChange();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        document.execCommand('insertText', false, '  ');
        emitChange();
        return;
      }
    }

    /* Tab 列表缩进 */
    if (e.key === 'Tab') {
      var s = getSel();
      if (s.rangeCount && nodeInside(s.anchorNode, ['LI'])) {
        e.preventDefault();
        exec(e.shiftKey ? 'outdent' : 'indent');
        return;
      }
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
      emitChange();
      return;
    }

    /* Enter 块级转换 */
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
      if (tryEnterShortcut(e)) return;
    }
  }

  function onInput(e) {
    if (e.inputType === 'insertText') {
      if (e.data === ' ') {
        tryBlockShortcut();
      } else if (e.data && /[*`~$_)\]$]/.test(e.data)) {
        tryInlineFormat();
      }
    }
    emitChange();
  }

  /* ---------------- 点击事件 ---------------- */

  function onClick(e) {
    var mathEl = e.target.closest ? e.target.closest('.math') : null;
    if (mathEl && editor.contains(mathEl)) {
      e.preventDefault();
      openMathEditor(mathEl);
      return;
    }
    var cb = e.target.closest ? e.target.closest('input[type="checkbox"]') : null;
    if (cb && editor.contains(cb)) {
      e.preventDefault();
      cb.checked = !cb.checked;
      emitChange();
      return;
    }
  }

  function onDblClick(e) {
    var mathEl = e.target.closest ? e.target.closest('.math') : null;
    if (mathEl && editor.contains(mathEl)) {
      e.preventDefault();
      openMathEditor(mathEl);
    }
  }

  /* ---------------- 焦点事件（代码块高亮切换） ---------------- */

  function onFocusIn(e) {
    var pre = e.target.closest ? e.target.closest('pre') : null;
    if (pre && editor.contains(pre)) {
      preHasFocus = true;
      dehighlightPre(pre);
    }
  }
  function onFocusOut(e) {
    var pre = e.target.closest ? e.target.closest('pre') : null;
    if (pre && editor.contains(pre) && !pre.contains(e.relatedTarget)) {
      preHasFocus = false;
      refreshPre(pre);
    }
  }

  /* ---------------- 初始化 ---------------- */

  function init(editorEl, mdKitInst, serializerInst, hookObj) {
    editor = editorEl;
    mdKit = mdKitInst;
    serializer = serializerInst;
    hooks = hookObj || {};

    mathPop = $('#math-pop');
    mathInput = $('#math-input');
    mathPreview = $('#math-preview');
    linkPop = $('#link-pop');
    linkText = $('#link-text');
    linkUrl = $('#link-url');
    imgPop = $('#img-pop');
    imgUrl = $('#img-url');
    imgAlt = $('#img-alt');

    editor.addEventListener('keydown', onKeydown);
    editor.addEventListener('input', onInput);
    editor.addEventListener('paste', onPaste);
    editor.addEventListener('click', onClick);
    editor.addEventListener('dblclick', onDblClick);
    editor.addEventListener('focusin', onFocusIn);
    editor.addEventListener('focusout', onFocusOut);

    /* 中文输入法组词期间不压栈，组词完成后记一步 */
    editor.addEventListener('compositionstart', function () { composing = true; });
    editor.addEventListener('compositionend', function () {
      composing = false;
      pushHistory();
      emitChange();
    });

    /* 回车产生 <p> 而非 <div> */
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) {}

    /* 公式浮层 */
    mathInput.addEventListener('input', updateMathPreview);
    mathInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); applyMathEdit(); }
      if (e.key === 'Escape') { closeMathEditor(); }
      e.stopPropagation();
    });
    $('#math-ok').addEventListener('click', applyMathEdit);
    $('#math-cancel').addEventListener('click', closeMathEditor);
    $('#math-del').addEventListener('click', deleteMathEl);

    /* 链接浮层 */
    $('#link-ok').addEventListener('click', applyLink);
    $('#link-cancel').addEventListener('click', function () { linkPop.classList.add('hidden'); });
    [linkText, linkUrl].forEach(function (inp) {
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
        if (e.key === 'Escape') { linkPop.classList.add('hidden'); }
        e.stopPropagation();
      });
    });

    /* 图片浮层 */
    $('#img-ok').addEventListener('click', function () {
      var url = imgUrl.value.trim();
      if (url) { insertImage(url, imgAlt.value.trim()); }
      imgPop.classList.add('hidden');
    });
    $('#img-cancel').addEventListener('click', function () { imgPop.classList.add('hidden'); });
    $('#img-local').addEventListener('click', function () {
      var input = $('#img-input');
      input.onchange = function () {
        var f = input.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          insertImage(reader.result, imgAlt.value.trim() || f.name);
          imgPop.classList.add('hidden');
        };
        reader.readAsDataURL(f);
        input.value = '';
      };
      input.click();
    });
    [imgUrl, imgAlt].forEach(function (inp) {
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); $('#img-ok').click(); }
        if (e.key === 'Escape') { imgPop.classList.add('hidden'); }
        e.stopPropagation();
      });
    });

    /* 点击空白处关闭浮层 */
    document.addEventListener('mousedown', function (e) {
      if (!e.target.closest('.popover') && !e.target.closest('.math') && !e.target.closest('#toolbar')) {
        hidePops();
      }
    });

    ensureStructure();
  }

  global.Wysiwyg = {
    init: init,
    setMarkdown: setMarkdown,
    getMarkdown: getMarkdown,
    insertMarkdown: insertMarkdown,
    execCommand: execCommand,
    undo: historyUndo,
    redo: historyRedo,
    touch: emitChange,
    saveSel: saveRange,
    restoreSel: restoreRange,
    refreshPre: refreshPre,
    insertImage: insertImage,
    currentBlock: currentBlock,
    hidePops: hidePops
  };
})(typeof window !== 'undefined' ? window : globalThis);
