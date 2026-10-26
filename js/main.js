/* ============================================================
 * main.js — 应用启动与全局快捷键
 * ============================================================ */
(function () {
  'use strict';

  var DRAFT_KEY = 'marklite-draft';
  var draftTimer = null;

  var WELCOME_MD = [
    '# 欢迎使用 MarkLite',
    '',
    '一个轻量级的 **Typora 风格** Markdown 编辑器。支持 *所见即所得* 编辑、HTML 语法、LaTeX 公式与字体自定义。',
    '',
    '## 快速上手',
    '',
    '直接输入 Markdown 语法即可即时渲染：',
    '',
    '- 输入 `# ` 创建标题，`> ` 创建引用，`- ` 创建列表',
    '- 输入 `**加粗**`、`*斜体*`、`` `行内代码` ``、`~~删除线~~` 即时生效',
    '- 输入 ``` 后回车创建代码块，输入 `$$` 后回车创建公式块',
    '- 输入 `[ ] ` 创建任务列表',
    '',
    '- [ ] 试试点击这个复选框',
    '- [x] 已完成的任务',
    '',
    '## LaTeX 数学公式',
    '',
    '行内公式：质能方程 $E = mc^2$，欧拉公式 $e^{i\\pi} + 1 = 0$。',
    '',
    '块级公式（点击可编辑）：',
    '',
    '$$',
    '\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}',
    '$$',
    '',
    '$$',
    '\\frac{\\partial}{\\partial t} \\Psi = \\frac{i\\hbar}{2m} \\nabla^2 \\Psi',
    '$$',
    '',
    '## 代码高亮',
    '',
    '```javascript',
    'function fib(n) {',
    '  return n < 2 ? n : fib(n - 1) + fib(n - 2);',
    '}',
    'console.log(fib(10)); // 55',
    '```',
    '',
    '```python',
    'def quicksort(arr):',
    '    if len(arr) <= 1:',
    '        return arr',
    '    pivot = arr[len(arr) // 2]',
    '    return quicksort([x for x in arr if x < pivot]) \\',
    '         + [x for x in arr if x == pivot] \\',
    '         + quicksort([x for x in arr if x > pivot])',
    '```',
    '',
    '## 表格',
    '',
    '| 功能 | 快捷键 | 说明 |',
    '| --- | --- | --- |',
    '| 保存 | Ctrl+S | 保存当前文件 |',
    '| 打开 | Ctrl+O | 打开 Markdown 文件 |',
    '| 源码模式 | Ctrl+/ | 切换源代码编辑 |',
    '| 加粗 | Ctrl+B | 切换加粗 |',
    '',
    '## HTML 语法支持',
    '',
    '可以直接书写 <u>下划线</u>、<mark>高亮</mark>、上标 H<sub>2</sub>O、x<sup>2</sup> 等 HTML 标签。',
    '',
    '<details>',
    '<summary>点击展开折叠内容</summary>',
    '',
    '这是折叠区域里的内容，可以包含任意 **Markdown** 与 HTML。',
    '',
    '</details>',
    '',
    '> 提示：右上角「Aa」按钮可自定义 **字体、字号、行高、主题**。',
    '',
    '---',
    '',
    '*开始你的创作吧！*'
  ].join('\n');

  /* ---------------- 初始化 ---------------- */

  function boot() {
    var editor = document.getElementById('editor');

    /* 渲染管线 */
    var mdKit = window.MdKit.create({
      markdownit: window.markdownit,
      katex: window.katex,
      hljs: window.hljs
    });

    /* 序列化管线 */
    var serializer = window.SerializeKit.create({
      TurndownService: window.TurndownService,
      gfm: window.turndownPluginGfm
    });

    /* UI 钩子 */
    window.UI.init(editor, {
      getMarkdown: function () { return window.Wysiwyg.getMarkdown(); },
      setMarkdown: function (text) { window.Wysiwyg.setMarkdown(text); },
      onSave: save
    });

    /* 编辑器钩子 */
    window.Wysiwyg.init(editor, mdKit, serializer, {
      onChange: function () {
        window.FileIO.markDirty();
        window.UI.scheduleOutline();
        window.UI.scheduleWordCount();
        scheduleDraft();
      },
      onPostRender: function () {
        window.FileIO.afterRender();
      }
    });

    /* 文件 IO 钩子 */
    window.FileIO.init({
      onContent: function (text) {
        window.Find.close();
        window.Wysiwyg.setMarkdown(text);
        clearDraft();
      },
      getContent: function () {
        return window.UI.inSourceMode() ? document.getElementById('source').value
          : window.Wysiwyg.getMarkdown();
      },
      onStatus: function (st) { window.UI.onStatus(st); },
      onImage: function (dataUrl, name) { window.Wysiwyg.insertImage(dataUrl, name); },
      onImageStatus: function (st) { window.UI.onImageStatus(st); },
      onRecentsChanged: function () { window.UI.rebuildRecents(); }
    });

    /* 初始文档：恢复草稿或显示欢迎页 */
    var draft = null;
    try { draft = localStorage.getItem(DRAFT_KEY); } catch (e) {}
    window.Wysiwyg.setMarkdown(draft || WELCOME_MD);
    window.FileIO.state.dirty = !!draft;
    window.FileIO.updateStatus();
    window.UI.rebuildOutline();
    window.UI.updateWordCount();

    window.Find.init(editor);
    window.AI.init(editor);
    initShortcuts();

    editor.focus();
  }

  function save() {
    window.FileIO.save();
  }

  /* ---------------- 草稿自动保存 ---------------- */

  function scheduleDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () {
      try {
        if (!window.FileIO.state.handle) {
          localStorage.setItem(DRAFT_KEY, window.Wysiwyg.getMarkdown());
        }
      } catch (e) {}
    }, 1500);
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
  }

  /* ---------------- 全局快捷键 ---------------- */

  function initShortcuts() {
    document.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      switch (e.key) {
        case 's': case 'S':
          e.preventDefault();
          if (e.shiftKey) window.FileIO.saveAs();
          else save();
          break;
        case 'o': case 'O':
          e.preventDefault();
          window.FileIO.open();
          break;
        case 'n': case 'N':
          e.preventDefault();
          window.FileIO.newFile();
          break;
        case 'b': case 'B':
          if (!window.UI.inSourceMode()) { e.preventDefault(); window.Wysiwyg.execCommand('bold'); }
          break;
        case 'i': case 'I':
          if (!window.UI.inSourceMode()) { e.preventDefault(); window.Wysiwyg.execCommand('italic'); }
          break;
        case 'k': case 'K':
          if (!window.UI.inSourceMode()) { e.preventDefault(); window.Wysiwyg.execCommand('link'); }
          break;
        case 'f': case 'F':
          if (!window.UI.inSourceMode()) { e.preventDefault(); window.Find.open(); }
          break;
        case '/':
          e.preventDefault();
          window.UI.toggleSource();
          break;
        case '1': case '2': case '3': case '4': case '5': case '6':
          if (!window.UI.inSourceMode() && !e.shiftKey) {
            e.preventDefault();
            window.Wysiwyg.execCommand('h' + e.key);
          }
          break;
        case '0':
          if (!window.UI.inSourceMode()) {
            e.preventDefault();
            window.Wysiwyg.execCommand('p');
          }
          break;
      }
    });
  }

  /* 启动 */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
