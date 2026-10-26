/* ============================================================
 * fileio.js — 文件打开/保存/最近文件/导出
 * ============================================================ */
(function (global) {
  'use strict';

  var hooks = {};
  var state = {
    handle: null,      // FileSystemFileHandle（支持时）
    name: '未命名',
    dirty: false
  };

  var hasFS = typeof window.showOpenFilePicker === 'function';

  /* ---------------- IndexedDB 最近文件 ---------------- */
  var DB_NAME = 'marklite', STORE = 'recents', MAX_RECENTS = 10;

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(STORE, { keyPath: 'name' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function addRecent(name, handle) {
    if (!handle) return;
    openDB().then(function (db) {
      var tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ name: name, handle: handle, time: Date.now() });
      tx.oncomplete = function () {
        /* 裁剪数量 */
        var tx2 = db.transaction(STORE, 'readwrite');
        var store = tx2.objectStore(STORE);
        store.getAll().onsuccess = function () {
          var all = this.result.sort(function (a, b) { return b.time - a.time; });
          all.slice(MAX_RECENTS).forEach(function (r) { store.delete(r.name); });
        };
      };
    }).catch(function () {});
  }

  function getRecents() {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        var req = db.transaction(STORE).objectStore(STORE).getAll();
        req.onsuccess = function () {
          resolve(req.result.sort(function (a, b) { return b.time - a.time; }));
        };
        req.onerror = function () { resolve([]); };
      });
    }).catch(function () { return []; });
  }

  function removeRecent(name) {
    openDB().then(function (db) {
      db.transaction(STORE, 'readwrite').objectStore(STORE).delete(name);
    }).catch(function () {});
  }

  /* ---------------- 权限 ---------------- */
  function verifyPermission(handle, write) {
    var opts = { mode: write ? 'readwrite' : 'read' };
    return handle.queryPermission(opts).then(function (p) {
      if (p === 'granted') return true;
      return handle.requestPermission(opts).then(function (p2) { return p2 === 'granted'; });
    });
  }

  /* ---------------- 打开 ---------------- */
  function openFile() {
    if (hasFS) {
      window.showOpenFilePicker({
        types: [{
          description: 'Markdown 文件',
          accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.txt'] }
        }],
        multiple: false
      }).then(function (handles) {
        return loadFromHandle(handles[0]);
      }).catch(function (err) {
        if (err && err.name !== 'AbortError') fallbackOpen();
      });
    } else {
      fallbackOpen();
    }
  }

  function fallbackOpen() {
    var input = document.getElementById('file-input');
    input.onchange = function () {
      var f = input.files[0];
      if (!f) return;
      readTextFile(f).then(function (text) {
        state.handle = null;
        setContent(text, f.name);
      });
      input.value = '';
    };
    input.click();
  }

  function readTextFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsText(file, 'utf-8');
    });
  }

  function loadFromHandle(handle) {
    return verifyPermission(handle, false).then(function (ok) {
      if (!ok) return;
      return handle.getFile().then(readTextFile).then(function (text) {
        state.handle = handle;
        setContent(text, handle.name);
        addRecent(handle.name, handle);
      });
    });
  }

  function openRecent(name) {
    getRecents().then(function (list) {
      var item = list.find(function (r) { return r.name === name; });
      if (!item) return;
      loadFromHandle(item.handle).catch(function () {
        removeRecent(name);
        if (hooks.onRecentsChanged) hooks.onRecentsChanged();
      });
    });
  }

  function setContent(text, name) {
    state.name = name || '未命名';
    state.dirty = false;
    if (hooks.onContent) hooks.onContent(text);
    updateStatus();
  }

  /* ---------------- 保存 ---------------- */
  function save() {
    var text = hooks.getContent();
    if (state.handle && hasFS) {
      return verifyPermission(state.handle, true).then(function (ok) {
        if (!ok) return saveAs();
        return state.handle.createWritable().then(function (w) {
          return w.write(text).then(function () { return w.close(); });
        }).then(function () {
          state.dirty = false;
          updateStatus();
        });
      }).catch(function () { saveAs(); });
    }
    return saveAs();
  }

  function saveAs() {
    var text = hooks.getContent();
    if (hasFS) {
      return window.showSaveFilePicker({
        suggestedName: state.name.replace(/\.(md|markdown|txt)$/i, '') + '.md',
        types: [{ description: 'Markdown 文件', accept: { 'text/markdown': ['.md'] } }]
      }).then(function (handle) {
        return handle.createWritable().then(function (w) {
          return w.write(text).then(function () { return w.close(); });
        }).then(function () {
          state.handle = handle;
          state.name = handle.name;
          state.dirty = false;
          addRecent(handle.name, handle);
          updateStatus();
        });
      }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        downloadBlob(new Blob([text], { type: 'text/markdown;charset=utf-8' }), state.name);
      });
    }
    downloadBlob(new Blob([text], { type: 'text/markdown;charset=utf-8' }),
      /\.md$/i.test(state.name) ? state.name : state.name + '.md');
    state.dirty = false;
    updateStatus();
    return Promise.resolve();
  }

  function downloadBlob(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  function newFile() {
    if (state.dirty && !window.confirm('当前文件未保存，确定新建吗？')) return;
    state.handle = null;
    setContent('# 未命名\n\n开始输入……\n', '未命名');
  }

  /* ---------------- 拖拽 ---------------- */
  function initDragDrop() {
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      var files = e.dataTransfer.files;
      if (!files || !files.length) return;
      var f = files[0];
      if (/\.(md|markdown|mdown|mkd|txt)$/i.test(f.name)) {
        if (state.dirty && !window.confirm('当前文件未保存，确定打开新文件吗？')) return;
        readTextFile(f).then(function (text) {
          state.handle = f.getAsFileSystemHandle ? null : null;
          setContent(text, f.name);
        });
      } else if (/^image\//.test(f.type)) {
        var reader = new FileReader();
        reader.onload = function () {
          if (hooks.onImage) hooks.onImage(reader.result, f.name);
        };
        reader.readAsDataURL(f);
      }
    });
  }

  /* ---------------- 导出 ---------------- */

  function exportHTML(mdKitInstance) {
    var body = document.getElementById('editor').innerHTML;
    var name = state.name.replace(/\.(md|markdown|txt)$/i, '');

    Promise.all([
      fetch('css/editor.css').then(function (r) { return r.text(); }).catch(function () { return ''; }),
      fetch('css/themes.css').then(function (r) { return r.text(); }).catch(function () { return ''; }),
      fetch('vendor/katex/katex.min.css').then(function (r) { return r.text(); }).catch(function () { return ''; }),
      fetch('vendor/highlight/github.min.css').then(function (r) { return r.text(); }).catch(function () { return ''; })
    ]).then(function (cssList) {
      var html = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n' +
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
        '<title>' + name + '</title>\n' +
        '<style>\n' + cssList[1] + '\n' + cssList[2] + '\n' + cssList[3] + '\n' + cssList[0] +
        '\nbody{background:var(--bg);color:var(--fg)}#editor{padding:32px 48px}\n</style>\n' +
        '</head>\n<body data-theme="light">\n<div id="editor">\n' + body + '\n</div>\n</body>\n</html>';
      downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), name + '.html');
    });
  }

  function exportPDF() {
    window.print();
  }

  /* ---------------- 相对路径图片解析 ---------------- */
  var imgDirHandle = null;   // 用户授权的文档文件夹（会话级缓存）
  var imgBlobCache = {};     // data-src → blob URL

  function isRelativeImg(src) {
    return src && !/^(https?:|data:|blob:|file:|\/|[a-zA-Z]:[\\/])/i.test(src);
  }

  /* 安全解码：非法 % 序列时回退原文 */
  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  /* 路径规范化：去 query/fragment、%5C→/、折叠 . 与 ..
   * .. 超出授权目录时钳制（授权目录视为可达根，用户选更上层文件夹即可命中） */
  function normalizeParts(relPath) {
    var clean = relPath.split(/[?#]/)[0].replace(/%5C/gi, '/');
    var raw = clean.split(/[\\/]+/);
    var stack = [];
    raw.forEach(function (p) {
      if (!p || p === '.') return;
      if (p === '..') { if (stack.length) stack.pop(); return; }
      stack.push(safeDecode(p));
    });
    return stack;
  }

  /* 取子句柄，NotFound 时列目录做大小写不敏感匹配（Windows 常见） */
  function getChild(dir, name, wantDir) {
    var primary = wantDir ? dir.getDirectoryHandle(name) : dir.getFileHandle(name);
    return primary.catch(function (err) {
      if (err && err.name !== 'NotFoundError') throw err;
      if (typeof dir.entries !== 'function') throw err;
      var lower = name.toLowerCase();
      return (async function () {
        for await (var entry of dir.entries()) {
          if (entry[0].toLowerCase() === lower) return entry[1];
        }
        throw err;
      })();
    });
  }

  /* 按相对路径逐级下钻目录 handle 取文件 */
  function resolvePath(dirHandle, relPath) {
    var parts = normalizeParts(relPath);
    if (!parts.length) return Promise.reject(new Error('empty path'));
    var chain = Promise.resolve(dirHandle);
    parts.slice(0, -1).forEach(function (seg) {
      chain = chain.then(function (d) { return getChild(d, seg, true); });
    });
    return chain.then(function (d) {
      return getChild(d, parts[parts.length - 1], false);
    }).then(function (fh) { return fh.getFile(); });
  }

  /* 在授权根的一层子目录中按文件名查找（用户选了图片文件夹的上级/本级时的兜底） */
  function searchSubdirs(base) {
    if (typeof imgDirHandle.entries !== 'function') return Promise.reject(new Error('not found'));
    return (async function () {
      var dirs = [];
      for await (var entry of imgDirHandle.entries()) {
        if (entry[1].kind === 'directory') dirs.push(entry[1]);
      }
      for (var i = 0; i < dirs.length; i++) {
        try { return await getChild(dirs[i], base, false); } catch (e) { /* 继续下一个 */ }
      }
      throw new Error('not found');
    })();
  }

  /* 单张图片解析链：完整相对路径 → 授权根按文件名 → 一层子目录按文件名 */
  function resolveOne(ds) {
    return resolvePath(imgDirHandle, ds).catch(function () {
      var parts = normalizeParts(ds);
      var base = parts[parts.length - 1];
      if (!base) throw new Error('not found');
      return getChild(imgDirHandle, base, false)
        .then(function (fh) { return fh.getFile(); })
        .catch(function () {
          return searchSubdirs(base).then(function (fh) { return fh.getFile(); });
        });
    });
  }

  function relativeImages() {
    var out = [];
    var imgs = document.querySelectorAll('#editor img');
    for (var i = 0; i < imgs.length; i++) {
      var ds = imgs[i].getAttribute('data-src') || '';
      if (isRelativeImg(ds)) out.push(imgs[i]);
    }
    return out;
  }

  /* 用已授权的目录把相对路径图片换成 blob 地址（仅显示层，data-src 不动） */
  function resolveImages() {
    if (!imgDirHandle) return Promise.resolve({ resolved: 0, total: relativeImages().length });
    var resolved = 0, total = 0;
    var jobs = relativeImages().map(function (img) {
      var ds = img.getAttribute('data-src') || '';
      total++;
      var cur = img.getAttribute('src') || '';
      if (cur.indexOf('blob:') === 0 && imgBlobCache[ds]) { resolved++; return null; }
      var p = imgBlobCache[ds]
        ? Promise.resolve(imgBlobCache[ds])
        : resolveOne(ds).then(function (file) {
            imgBlobCache[ds] = URL.createObjectURL(file);
            return imgBlobCache[ds];
          });
      return p.then(function (url) { img.src = url; img.removeAttribute('title'); resolved++; })
              .catch(function (err) {
                img.title = '图片未找到：' + ds + '（可尝试改选 .md 所在文件夹或图片所在文件夹）';
                if (window.console && console.warn) {
                  console.warn('[MarkLite] 图片解析失败:', ds, err && err.name, err && err.message);
                }
              });
    });
    return Promise.all(jobs).then(function () { return { resolved: resolved, total: total }; });
  }

  /* 每次渲染/粘贴后调用：统计相对路径图片并按需自动解析 */
  function afterRender() {
    var rel = relativeImages().length;
    if (imgDirHandle && rel) {
      resolveImages().then(function (res) { notifyImg(res.total, res.resolved); });
    } else {
      notifyImg(rel, 0);
    }
  }

  function notifyImg(relative, resolved) {
    if (hooks.onImageStatus) {
      hooks.onImageStatus({ relative: relative, resolved: resolved, granted: !!imgDirHandle });
    }
  }

  /* 弹出目录选择器，授权后立即解析 */
  function grantImageFolder() {
    if (typeof window.showDirectoryPicker !== 'function') return Promise.resolve(false);
    return window.showDirectoryPicker().then(function (h) {
      imgDirHandle = h;
      return resolveImages();
    }).then(function (res) {
      notifyImg(res.total, res.resolved);
      return true;
    }).catch(function () { return false; }); /* 用户取消或不支持 */
  }

  /* ---------------- 状态 ---------------- */
  function markDirty() {
    state.dirty = true;
    updateStatus();
  }

  function updateStatus() {
    if (hooks.onStatus) hooks.onStatus({
      name: state.name,
      dirty: state.dirty,
      hasFS: hasFS
    });
    document.title = (state.dirty ? '● ' : '') + state.name + ' - MarkLite';
  }

  /* ---------------- 初始化 ---------------- */
  function init(hookObj) {
    hooks = hookObj || {};
    initDragDrop();
    window.addEventListener('beforeunload', function (e) {
      if (state.dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  global.FileIO = {
    init: init,
    open: openFile,
    openRecent: openRecent,
    save: save,
    saveAs: saveAs,
    newFile: newFile,
    exportHTML: exportHTML,
    exportPDF: exportPDF,
    markDirty: markDirty,
    getRecents: getRecents,
    state: state,
    updateStatus: updateStatus,
    afterRender: afterRender,
    grantImageFolder: grantImageFolder
  };
})(typeof window !== 'undefined' ? window : globalThis);
