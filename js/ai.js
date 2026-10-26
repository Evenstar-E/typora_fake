/* ============================================================
 * ai.js — AI 写作助手面板
 * 通过 server.js 的 /api/ai 端点调用本机 Claude Code CLI（claude -p），
 * SSE 流式接收结果；支持替换选区 / 插入光标处 / 复制。
 * ============================================================ */
(function (global) {
  'use strict';

  var editor = null;
  var panel, instructionEl, outputEl, statusEl, sendBtn, stopBtn;
  var aborter = null;
  var running = false;
  var lastSelText = null; /* 最近一次编辑器选区（随 selectionchange 持续跟踪，不怕焦点销毁） */

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  /* ---------------- 上下文收集 ---------------- */

  function getContext() {
    var sel = window.getSelection();
    if (sel.rangeCount && !sel.isCollapsed && editor.contains(sel.anchorNode)) {
      var t = sel.toString().trim();
      if (t) return { text: t.slice(0, 12000), fromSelection: true };
    }
    /* 当前选区已被输入框焦点销毁时，退回最近跟踪到的选区 */
    if (lastSelText) return { text: lastSelText, fromSelection: true };
    return { text: global.Wysiwyg.getMarkdown().slice(0, 12000), fromSelection: false };
  }

  /* 持续跟踪编辑器选区：选中即缓存+保存 Range；新光标（折叠）即清除 */
  function trackSelection() {
    var sel = window.getSelection();
    if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return;
    if (!sel.isCollapsed) {
      var t = sel.toString().trim();
      lastSelText = t ? t.slice(0, 12000) : null;
      global.Wysiwyg.saveSel();
    } else {
      lastSelText = null;
    }
  }

  /* ---------------- 状态显示 ---------------- */

  function setStatus(text, isError) {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('error', !!isError);
    statusEl.title = text || '';
  }

  function setRunning(v) {
    running = v;
    sendBtn.disabled = v;
    stopBtn.disabled = !v;
  }

  /* ---------------- 发送与流式接收 ---------------- */

  function send(instruction) {
    if (running) return;
    instruction = (instruction || '').trim();
    if (!instruction) {
      setStatus('请输入指令或点击快捷指令', true);
      return;
    }
    var ctx = getContext();
    global.Wysiwyg.saveSel(); /* 保存选区，供"替换选区"使用 */

    setRunning(true);
    setStatus(ctx.fromSelection ? '思考中…（基于选区）' : '思考中…（基于全文）');
    outputEl.classList.remove('ai-empty');
    outputEl.textContent = '';

    aborter = new AbortController();
    fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: instruction, text: ctx.text }),
      signal: aborter.signal
    }).then(function (resp) {
      if (!resp.ok || !resp.body) {
        return resp.text().then(function (t) {
          throw new Error('HTTP ' + resp.status + '：' + t.slice(0, 200));
        });
      }
      return readStream(resp.body.getReader());
    }).then(function () {
      setStatus('完成');
      setRunning(false);
    }).catch(function (err) {
      if (err && err.name === 'AbortError') {
        setStatus('已停止');
      } else {
        setStatus('失败：' + (err && err.message || err) + '（需通过 node server.js 启动）', true);
      }
      setRunning(false);
    });
  }

  function readStream(reader) {
    var decoder = new TextDecoder();
    var buf = '';
    var gotAny = false;
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return;
        buf += decoder.decode(r.value, { stream: true });
        var idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          var frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          handleFrame(frame);
          if (outputEl.textContent) gotAny = true;
        }
        return pump();
      });
    }
    function handleFrame(frame) {
      if (frame.indexOf('data: ') !== 0) return;
      var data = frame.slice(6);
      if (data === '[DONE]') return;
      var obj;
      try { obj = JSON.parse(data); } catch (e) { return; }
      if (obj.error) {
        setStatus(obj.error, true);
      } else if (obj.thinking !== undefined) {
        setStatus('思考中… ≈' + obj.thinking + ' tokens');
      } else if (obj.text !== undefined) {
        outputEl.textContent = obj.text;
        outputEl.scrollTop = outputEl.scrollHeight;
      } else if (obj.cost !== undefined) {
        setStatus('完成（$' + Number(obj.cost).toFixed(4) + '）');
      }
    }
    return pump().then(function () {
      if (!gotAny && !outputEl.textContent) {
        /* 流结束但无文本（可能 CLI 报错已写 status） */
      }
    });
  }

  function stop() {
    if (aborter) aborter.abort();
  }

  /* ---------------- 结果应用 ---------------- */

  function applyReplace() {
    var text = outputEl.textContent.trim();
    if (!text) return;
    global.Wysiwyg.restoreSel();
    global.Wysiwyg.insertMarkdown(text); /* 选区非折叠时 insertHTML 直接替换 */
    editor.focus();
  }

  function applyInsert() {
    var text = outputEl.textContent.trim();
    if (!text) return;
    global.Wysiwyg.restoreSel();
    var sel = window.getSelection();
    if (sel.rangeCount) sel.collapseToEnd(); /* 折叠为光标，插入而非替换 */
    global.Wysiwyg.insertMarkdown(text);
    editor.focus();
  }

  function applyCopy() {
    var text = outputEl.textContent;
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        setStatus('已复制到剪贴板');
      });
    }
  }

  /* ---------------- 初始化 ---------------- */

  function init(editorEl) {
    editor = editorEl;
    panel = $('#ai-panel');
    instructionEl = $('#ai-instruction');
    outputEl = $('#ai-output');
    statusEl = $('#ai-status');
    sendBtn = $('#ai-send');
    stopBtn = $('#ai-stop');

    $('#btn-ai').addEventListener('mousedown', function (e) { e.preventDefault(); });
    $('#btn-ai').addEventListener('click', function () {
      var opening = panel.classList.contains('hidden');
      panel.classList.toggle('hidden');
      if (opening) instructionEl.focus();
    });
    $('#ai-close').addEventListener('click', function () {
      panel.classList.add('hidden');
    });

    /* 持续跟踪编辑器选区（在面板获得焦点之前就缓存） */
    document.addEventListener('selectionchange', trackSelection);

    /* 阻止按钮 mousedown 默认行为，避免点击时清掉编辑器选区 */
    $all('#ai-panel button').forEach(function (btn) {
      btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    });

    $all('.ai-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        instructionEl.value = chip.dataset.ins;
        send(chip.dataset.ins);
      });
    });

    sendBtn.addEventListener('click', function () { send(instructionEl.value); });
    stopBtn.addEventListener('click', stop);
    instructionEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        send(instructionEl.value);
      }
      if (!(e.ctrlKey || e.metaKey)) e.stopPropagation();
    });

    $('#ai-replace').addEventListener('click', applyReplace);
    $('#ai-insert').addEventListener('click', applyInsert);
    $('#ai-copy').addEventListener('click', applyCopy);
  }

  global.AI = { init: init, send: send };
})(typeof window !== 'undefined' ? window : globalThis);
