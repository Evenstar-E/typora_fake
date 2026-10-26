/* ============================================================
 * ui.js — 侧边栏大纲 / 设置面板 / 状态栏 / 源码模式
 * ============================================================ */
(function (global) {
  'use strict';

  var editor, cm = null, sourceMode = false;
  var hooks = {};
  var outlineTimer = null, wordTimer = null;

  var PREFS_KEY = 'marklite-prefs';

  var prefs = {
    theme: 'light',
    fontLatin: 'system-ui',
    fontCjk: "'Microsoft YaHei'",
    codefont: "Consolas, 'Courier New', monospace",
    size: 16,
    lineHeight: 1.7,
    width: 860,
    focusMode: false,
    typewriter: false
  };

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  /* ---------------- 偏好设置 ---------------- */

  function loadPrefs() {
    try {
      var saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      Object.keys(prefs).forEach(function (k) {
        if (saved[k] !== undefined) prefs[k] = saved[k];
      });
    } catch (e) {}
  }

  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}
  }

  /* 动态 @font-face：用 unicode-range 把中文字体钉在中文字符区间上。
   * 否则 system-ui 会经 Windows 字体链接"吞掉"中文（回退到雅黑），
   * 导致排在后面的中文字体永远不生效。 */
  var cjkFaceStyle = null;
  var CJK_RANGE = 'U+2E80-9FFF, U+F900-FAFF, U+3000-303F, U+FF00-FFEF, ' +
                  'U+2014, U+2018-2019, U+201C-201D, U+2026';

  function applyPrefs() {
    document.body.dataset.theme = prefs.theme;
    var root = document.documentElement;
    if (!cjkFaceStyle) {
      cjkFaceStyle = document.createElement('style');
      document.head.appendChild(cjkFaceStyle);
    }
    cjkFaceStyle.textContent =
      "@font-face { font-family: 'ML-CJK'; src: local(" + prefs.fontCjk +
      "); unicode-range: " + CJK_RANGE + "; }";
    /* ML-CJK 仅覆盖中文区间：英文跳过它走西文字体，中文命中它走中文字体 */
    root.style.setProperty('--font-body',
      "'ML-CJK', " + prefs.fontLatin + ', ' + prefs.fontCjk + ', sans-serif');
    root.style.setProperty('--font-code', prefs.codefont);
    root.style.setProperty('--font-size', prefs.size + 'px');
    root.style.setProperty('--line-height', prefs.lineHeight);
    root.style.setProperty('--content-width', (prefs.width >= 99999 ? '100%' : prefs.width + 'px'));

    /* 夜间模式切换 highlight 主题 */
    var dark = prefs.theme === 'night';
    $('#hljs-dark').disabled = !dark;
    $('#hljs-dark').media = dark ? 'all' : 'none';
    $('#hljs-light').disabled = dark;
    $('#hljs-light').media = dark ? 'none' : 'all';

    /* 同步面板控件 */
    $('#set-theme').value = prefs.theme;
    $('#set-font-latin').value = prefs.fontLatin;
    $('#set-font-cjk').value = prefs.fontCjk;
    $('#set-codefont').value = prefs.codefont;
    document.body.classList.toggle('focus-mode', prefs.focusMode);
    $('#set-focus').checked = prefs.focusMode;
    $('#set-typewriter').checked = prefs.typewriter;
    $('#set-size').value = prefs.size;
    $('#set-lineheight').value = prefs.lineHeight;
    $('#set-width').value = String(prefs.width);
    $('#font-size-val').textContent = prefs.size;
    $('#line-height-val').textContent = prefs.lineHeight;
  }

  function initSettings() {
    $('#set-theme').addEventListener('change', function () { prefs.theme = this.value; applyPrefs(); savePrefs(); });
    $('#set-font-latin').addEventListener('change', function () { prefs.fontLatin = this.value; applyPrefs(); savePrefs(); });
    $('#set-font-cjk').addEventListener('change', function () { prefs.fontCjk = this.value; applyPrefs(); savePrefs(); });
    $('#set-codefont').addEventListener('change', function () { prefs.codefont = this.value; applyPrefs(); savePrefs(); });
    $('#set-size').addEventListener('input', function () { prefs.size = +this.value; applyPrefs(); savePrefs(); });
    $('#set-lineheight').addEventListener('input', function () { prefs.lineHeight = +this.value; applyPrefs(); savePrefs(); });
    $('#set-width').addEventListener('change', function () { prefs.width = +this.value; applyPrefs(); savePrefs(); });
    $('#set-focus').addEventListener('change', function () { prefs.focusMode = this.checked; applyPrefs(); savePrefs(); updateFocus(); });
    $('#set-typewriter').addEventListener('change', function () { prefs.typewriter = this.checked; applyPrefs(); savePrefs(); });

    $('#btn-settings').addEventListener('click', function (e) {
      e.stopPropagation();
      var panel = $('#settings-panel');
      var btn = e.target.closest('button').getBoundingClientRect();
      panel.classList.toggle('hidden');
      panel.style.top = (btn.bottom + 8) + 'px';
      panel.style.right = '10px';
      panel.style.left = 'auto';
    });
  }

  /* ---------------- 大纲 ---------------- */

  function rebuildOutline() {
    var pane = $('#side-outline');
    var headings = $all('#editor h1, #editor h2, #editor h3, #editor h4, #editor h5, #editor h6');
    if (!headings.length) {
      pane.innerHTML = '<div class="outline-empty">文档暂无标题大纲</div>';
      return;
    }
    pane.innerHTML = '';
    headings.forEach(function (h) {
      var lv = +h.nodeName[1];
      var item = document.createElement('span');
      item.className = 'outline-item lv' + lv;
      item.textContent = h.textContent || '（空标题）';
      item.title = h.textContent;
      item.addEventListener('click', function () {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      pane.appendChild(item);
    });
  }

  function scheduleOutline() {
    clearTimeout(outlineTimer);
    outlineTimer = setTimeout(rebuildOutline, 400);
  }

  /* ---------------- 最近文件列表 ---------------- */

  function rebuildRecents() {
    global.FileIO.getRecents().then(function (list) {
      var pane = $('#recent-list');
      pane.innerHTML = list.length ? '' : '<div class="outline-empty">暂无最近文件</div>';
      list.forEach(function (r) {
        var item = document.createElement('a');
        item.className = 'recent-item';
        item.innerHTML = '<span class="name"></span><span class="path">点击重新打开</span>';
        item.querySelector('.name').textContent = r.name;
        item.addEventListener('click', function () { global.FileIO.openRecent(r.name); });
        pane.appendChild(item);
      });
    });
  }

  /* ---------------- 状态栏 ---------------- */

  function updateWordCount() {
    var text = sourceMode && cm ? cm.getValue() : editor.innerText || '';
    var cjk = (text.match(/[一-鿿　-〿＀-￯]/g) || []).length;
    var latin = text.replace(/[一-鿿　-〿＀-￯]/g, ' ').split(/\s+/).filter(function (w) {
      return /[A-Za-z0-9]/.test(w);
    }).length;
    var total = cjk + latin;
    $('#st-words').textContent = '字数 ' + total;
  }

  function scheduleWordCount() {
    clearTimeout(wordTimer);
    wordTimer = setTimeout(updateWordCount, 300);
  }

  function onStatus(st) {
    $('#st-file').textContent = st.name;
    $('#st-file').title = st.name;
    var el = $('#st-state');
    el.textContent = st.dirty ? '未保存' : '已保存';
    el.classList.toggle('dirty', st.dirty);
  }

  /* ---------------- 源码模式 ---------------- */

  function toggleSource() {
    var srcWrap = $('#source-wrap');
    if (!sourceMode) {
      /* 进入源码模式 */
      if (!cm) {
        cm = global.CodeMirror.fromTextArea($('#source'), {
          mode: 'markdown',
          lineNumbers: false,
          lineWrapping: true,
          styleActiveLine: true,
          autofocus: true,
          extraKeys: {
            'Ctrl-S': function () { hooks.onSave && hooks.onSave(); },
            'Cmd-S': function () { hooks.onSave && hooks.onSave(); }
          }
        });
        cm.on('change', function () {
          global.FileIO.markDirty();
          scheduleWordCount();
        });
      }
      cm.setValue(hooks.getMarkdown());
      editor.style.display = 'none';
      srcWrap.classList.remove('hidden');
      sourceMode = true;
      $('#btn-source').classList.add('active');
      setTimeout(function () { cm.refresh(); cm.focus(); }, 0);
    } else {
      /* 返回所见即所得 */
      var text = cm.getValue();
      srcWrap.classList.add('hidden');
      editor.style.display = '';
      sourceMode = false;
      $('#btn-source').classList.remove('active');
      hooks.setMarkdown(text);
    }
  }

  function inSourceMode() { return sourceMode; }

  /* ---------------- 专注 / 打字机 ---------------- */

  function updateFocus() {
    if (!prefs.focusMode && !prefs.typewriter) return;
    if (sourceMode) return;
    var sel = window.getSelection();
    if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return;

    var block = global.Wysiwyg.currentBlock();
    if (!block) return;
    /* 顶层块 */
    var top = block;
    while (top.parentNode && top.parentNode !== editor) top = top.parentNode;

    if (prefs.focusMode) {
      $all('#editor > .focus-current').forEach(function (el) { el.classList.remove('focus-current'); });
      top.classList.add('focus-current');
    }
    if (prefs.typewriter) {
      var rect = top.getBoundingClientRect();
      var centerDelta = (rect.top + rect.height / 2) - window.innerHeight / 2;
      if (Math.abs(centerDelta) > 120) {
        top.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  /* ---------------- 工具栏激活态 ---------------- */

  function updateToolbarState() {
    if (sourceMode) return;
    var sel = window.getSelection();
    if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return;

    var states = {
      bold: 'bold', italic: 'italic', strikeThrough: 'strikeThrough',
      insertUnorderedList: 'insertUnorderedList', insertOrderedList: 'insertOrderedList'
    };
    $all('.tb-btn.fmt').forEach(function (btn) {
      var cmd = btn.dataset.cmd;
      if (!states[cmd]) return;
      try {
        btn.classList.toggle('active', document.queryCommandState(states[cmd]));
      } catch (e) {}
    });

    /* 段落格式下拉 */
    var block = global.Wysiwyg.currentBlock();
    var selBlock = $('#sel-block');
    if (block) {
      var name = block.nodeName.toLowerCase();
      if (/^(p|h[1-6]|blockquote|pre)$/.test(name)) selBlock.value = name;
      else selBlock.value = 'p';
    }
  }

  /* ---------------- 图片解析提示条 ---------------- */

  function onImageStatus(st) {
    var banner = $('#img-banner');
    if (!st.relative || st.relative === st.resolved) {
      banner.classList.add('hidden');
      return;
    }
    banner.classList.remove('hidden');
    var btn = $('#img-banner-btn');
    if (typeof window.showDirectoryPicker !== 'function') {
      $('#img-banner-text').textContent = '检测到 ' + st.relative + ' 张相对路径图片，但当前浏览器不支持文件夹授权（请用 Chrome / Edge）';
      btn.disabled = true;
      btn.textContent = '不可用';
      return;
    }
    btn.disabled = false;
    if (st.granted) {
      $('#img-banner-text').textContent =
        '有 ' + (st.relative - st.resolved) + ' 张图片未找到：请改选 .md 文件所在文件夹，或图片所在文件夹';
      btn.textContent = '重新选择文件夹…';
    } else {
      $('#img-banner-text').textContent =
        '检测到 ' + st.relative + ' 张相对路径图片，选择 .md 文件所在文件夹后即可显示';
      btn.textContent = '选择文件夹…';
    }
  }

  function initImgBanner() {
    $('#img-banner-btn').addEventListener('click', function () {
      global.FileIO.grantImageFolder();
    });
    $('#img-banner-close').addEventListener('click', function () {
      $('#img-banner').classList.add('hidden');
    });
  }

  /* ---------------- 初始化 ---------------- */

  function init(editorEl, hookObj) {
    editor = editorEl;
    hooks = hookObj || {};

    loadPrefs();
    applyPrefs();
    initSettings();
    initImgBanner();

    /* 侧边栏 */
    $('#btn-sidebar').addEventListener('click', function () {
      $('#sidebar').classList.toggle('collapsed');
    });
    $all('.side-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        $all('.side-tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        $('#side-outline').classList.toggle('hidden', tab.dataset.tab !== 'outline');
        $('#side-files').classList.toggle('hidden', tab.dataset.tab !== 'files');
        if (tab.dataset.tab === 'files') rebuildRecents();
      });
    });

    /* 工具栏命令按钮 */
    $all('[data-cmd]').forEach(function (btn) {
      btn.addEventListener('mousedown', function (e) {
        e.preventDefault(); /* 保持编辑器选区 */
      });
      btn.addEventListener('click', function () {
        global.Wysiwyg.execCommand(btn.dataset.cmd);
      });
    });
    $('#sel-block').addEventListener('change', function () {
      global.Wysiwyg.execCommand(this.value);
    });

    /* 文件按钮 */
    $('#btn-open').addEventListener('click', function () { global.FileIO.open(); });
    $('#btn-save').addEventListener('click', function () { hooks.onSave && hooks.onSave(); });
    $('#btn-new').addEventListener('click', function () { global.FileIO.newFile(); });

    /* 源码模式 */
    $('#btn-source').addEventListener('click', toggleSource);

    /* 导出菜单 */
    $('#btn-export').addEventListener('click', function (e) {
      e.stopPropagation();
      var menu = $('#export-menu');
      var btn = e.target.closest('button').getBoundingClientRect();
      menu.classList.toggle('hidden');
      menu.style.top = (btn.bottom + 8) + 'px';
      menu.style.right = '10px';
      menu.style.left = 'auto';
    });
    $('#exp-html').addEventListener('click', function () {
      $('#export-menu').classList.add('hidden');
      global.FileIO.exportHTML();
    });
    $('#exp-pdf').addEventListener('click', function () {
      $('#export-menu').classList.add('hidden');
      global.FileIO.exportPDF();
    });
    $('#exp-md').addEventListener('click', function () {
      $('#export-menu').classList.add('hidden');
      global.FileIO.saveAs();
    });

    /* 编辑器变化 → 大纲/字数 */
    document.addEventListener('selectionchange', function () {
      clearTimeout(updateToolbarState._t);
      updateToolbarState._t = setTimeout(function () {
        updateToolbarState();
        updateFocus();
      }, 120);
    });

    rebuildOutline();
    updateWordCount();
  }

  global.UI = {
    init: init,
    onStatus: onStatus,
    onImageStatus: onImageStatus,
    scheduleOutline: scheduleOutline,
    scheduleWordCount: scheduleWordCount,
    rebuildOutline: rebuildOutline,
    rebuildRecents: rebuildRecents,
    toggleSource: toggleSource,
    inSourceMode: inSourceMode,
    updateWordCount: updateWordCount
  };
})(typeof window !== 'undefined' ? window : globalThis);
