/* ============================================================
 * 浏览器冒烟测试：用系统 Edge/Chrome 无头模式验证应用
 * 运行：node test/smoke.js
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const PORT = 8891;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8'
};

function findBrowser() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'
  ];
  return candidates.find(p => fs.existsSync(p));
}

function startServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const fp = path.normalize(path.join(ROOT, p));
      fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); res.end('nf'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
        res.end(data);
      });
    }).listen(PORT, () => resolve(srv));
  });
}

let passed = 0, failed = 0;
function report(name, ok, extra) {
  if (ok) { passed++; console.log('✓ ' + name); }
  else { failed++; console.log('✗ ' + name + (extra ? '\n    ' + extra : '')); }
}

(async () => {
  const browserPath = findBrowser();
  if (!browserPath) { console.error('未找到浏览器'); process.exit(1); }
  const srv = await startServer();
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const url = (m.location() && m.location().url) || '';
    /* 图片测试用例会故意触发图片 404 / 假 blob 加载错误，不计入 JS 错误；
     * .js/.css/字体等资源加载失败仍然计入 */
    if (/\.(png|jpe?g|gif|webp|svg|bmp|ico)(\?|#|$)/i.test(url)) return;
    if (m.text().includes('blob:http://localhost/fake')) return;
    consoleErrors.push(m.text());
  });
  page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForSelector('#editor h1', { timeout: 10000 });

  /* 1. 页面无错误加载 */
  report('页面加载无 JS 错误', consoleErrors.length === 0, consoleErrors.join('\n'));

  /* 2. 欢迎文档渲染出标题/表格/代码块 */
  report('欢迎文档渲染（标题/表格/代码块）', await page.evaluate(() =>
    !!document.querySelector('#editor h1') &&
    !!document.querySelector('#editor table') &&
    !!document.querySelector('#editor pre code.hljs')
  ));

  /* 3. KaTeX 公式渲染 */
  report('KaTeX 行内与块级公式渲染', await page.evaluate(() =>
    !!document.querySelector('#editor .math-inline .katex') &&
    !!document.querySelector('#editor .math-block .katex')
  ));

  /* 4. 任务列表渲染 */
  report('任务列表复选框渲染', await page.evaluate(() =>
    document.querySelectorAll('#editor li.task-list-item input[type=checkbox]').length >= 2
  ));

  /* 5. Markdown 输入快捷键：标题 */
  await page.evaluate(() => {
    const ed = document.getElementById('editor');
    ed.focus();
    const p = document.createElement('p');
    p.innerHTML = '<br>';
    ed.appendChild(p);
    const r = document.createRange();
    r.setStart(p, 0); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.keyboard.type('## ');
  await page.keyboard.type('测试标题');
  report('输入 "## " 自动转标题', await page.evaluate(() => {
    const hs = document.querySelectorAll('#editor h2');
    return hs.length > 0 && hs[hs.length - 1].textContent === '测试标题';
  }));

  /* 6. 行内加粗自动格式化 */
  await page.keyboard.press('Enter');
  await page.keyboard.type('**粗体**');
  report('输入 **x** 自动加粗', await page.evaluate(() => {
    const st = document.querySelectorAll('#editor strong');
    return st.length > 0 && st[st.length - 1].textContent === '粗体';
  }));

  /* 7. 行内公式自动格式化 */
  await page.keyboard.type(' 和 $a^2+b^2=c^2$ 结束');
  report('输入 $x$ 自动渲染公式', await page.evaluate(() => {
    const ms = document.querySelectorAll('#editor .math-inline');
    const last = ms[ms.length - 1];
    return last && last.getAttribute('data-latex') === 'a^2+b^2=c^2';
  }));

  /* 8. getMarkdown 往返：新输入内容能被序列化 */
  const mdOut = await page.evaluate(() => window.Wysiwyg.getMarkdown());
  report('序列化包含新内容', mdOut.includes('## 测试标题') && mdOut.includes('**粗体**') && mdOut.includes('$a^2+b^2=c^2$'),
    mdOut.slice(-400));

  /* 9. 源码模式切换 */
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.UI.toggleSource());
  await new Promise(r => setTimeout(r, 400));
  const srcVisible = await page.evaluate(() =>
    !document.getElementById('source-wrap').classList.contains('hidden') &&
    document.querySelector('.CodeMirror') !== null
  );
  report('源码模式（CodeMirror）显示', srcVisible);
  const srcVal = await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue());
  report('源码内容正确', srcVal.includes('## 测试标题'));
  await page.evaluate(() => window.UI.toggleSource());
  await new Promise(r => setTimeout(r, 300));
  report('切回所见即所得', await page.evaluate(() =>
    document.getElementById('source-wrap').classList.contains('hidden') &&
    !!document.querySelector('#editor h2')
  ));

  /* 10. 大纲生成 */
  report('侧边栏大纲生成', await page.evaluate(() =>
    document.querySelectorAll('#side-outline .outline-item').length >= 4
  ));

  /* 11. 字数统计 */
  report('状态栏字数统计', await page.evaluate(() =>
    /字数 \d+/.test(document.getElementById('st-words').textContent) &&
    !/字数 0/.test(document.getElementById('st-words').textContent)
  ));

  /* 12. 主题切换 */
  await page.select('#set-theme', 'night');
  report('夜间主题切换', await page.evaluate(() => document.body.dataset.theme === 'night'));
  await page.select('#set-theme', 'light');

  /* 13. 中英文字体切换 */
  await page.select('#set-font-cjk', 'SimSun');
  report('中文字体切换为宋体', await page.evaluate(() =>
    getComputedStyle(document.getElementById('editor')).fontFamily.includes('SimSun')
  ));
  await page.select('#set-font-latin', 'Georgia');
  report('西文字体切换为 Georgia', await page.evaluate(() =>
    getComputedStyle(document.getElementById('editor')).fontFamily.includes('Georgia')
  ));

  /* 14. 代码块输入快捷键 */
  await page.evaluate(() => {
    const ed = document.getElementById('editor');
    ed.focus();
    const p = document.createElement('p');
    p.textContent = '```js';
    ed.appendChild(p);
    const r = document.createRange();
    r.selectNodeContents(p); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 200));
  report('```js + 回车创建代码块', await page.evaluate(() => {
    const pres = document.querySelectorAll('#editor pre');
    const last = pres[pres.length - 1];
    return last && last.getAttribute('data-lang') === 'js' && last.querySelector('code');
  }));
  await page.keyboard.type('const a = 1;');
  await page.keyboard.press('Escape');

  /* 15. $$ + 回车创建公式块并弹出编辑器 */
  await page.evaluate(() => {
    const ed = document.getElementById('editor');
    const p = document.createElement('p');
    p.textContent = '$$';
    ed.appendChild(p);
    const r = document.createRange();
    r.selectNodeContents(p); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    ed.focus();
  });
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 300));
  report('$$ + 回车创建公式块并打开编辑器', await page.evaluate(() =>
    !!document.querySelector('#editor .math-block[data-latex=""]') &&
    !document.getElementById('math-pop').classList.contains('hidden')
  ));
  /* 输入 LaTeX 并确认 */
  await page.click('#math-input');
  await page.keyboard.type('\\sum_{i=1}^{n} i');
  await page.click('#math-ok');
  await new Promise(r => setTimeout(r, 200));
  report('公式块编辑应用', await page.evaluate(() => {
    const blocks = document.querySelectorAll('#editor .math-block');
    const last = blocks[blocks.length - 1];
    return last.getAttribute('data-latex') === '\\sum_{i=1}^{n} i' && !!last.querySelector('.katex');
  }));

  /* 16. 图片 data-src 保真 */
  await page.evaluate(() => window.Wysiwyg.setMarkdown('![测试图](images/demo.png)\n'));
  await new Promise(r => setTimeout(r, 200));
  report('图片原始路径备份到 data-src', await page.evaluate(() => {
    const img = document.querySelector('#editor img');
    return img && img.getAttribute('data-src') === 'images/demo.png';
  }));
  report('序列化写回原始图片路径', await page.evaluate(() =>
    window.Wysiwyg.getMarkdown().includes('![测试图](images/demo.png)')
  ));
  /* 模拟显示层把 src 换成 blob 地址 */
  await page.evaluate(() => {
    document.querySelector('#editor img').setAttribute('src', 'blob:http://localhost/fake');
  });
  report('src 被替换后保存仍写回原路径', await page.evaluate(() => {
    const md = window.Wysiwyg.getMarkdown();
    return md.includes('![测试图](images/demo.png)') && !md.includes('blob:');
  }));

  /* 17. 相对路径图片：提示条 + 模拟授权解析 */
  await page.evaluate(() => {
    /* 把上一用例的假 blob 还原为相对路径，模拟真实加载失败场景 */
    document.querySelector('#editor img').setAttribute('src', 'images/demo.png');
    window.FileIO.afterRender();
  });
  await new Promise(r => setTimeout(r, 300));
  report('检测到相对路径图片并显示提示条', await page.evaluate(() =>
    !document.getElementById('img-banner').classList.contains('hidden') &&
    document.getElementById('img-banner-text').textContent.includes('1 张')
  ));
  /* mock 目录授权：目录树含 images/demo.png、shared/top.png、'pic name.png'、pic.png */
  await page.evaluate(() => {
    const F = (n) => new File(['fake-' + n], n, { type: 'image/png' });
    function makeHandle(tree) {
      return {
        kind: 'directory',
        getFileHandle: async (name) => {
          if (tree[name] instanceof File) return { kind: 'file', getFile: async () => tree[name] };
          throw new DOMException('not found', 'NotFoundError');
        },
        getDirectoryHandle: async (name) => {
          if (tree[name] && !(tree[name] instanceof File)) return makeHandle(tree[name]);
          throw new DOMException('not found', 'NotFoundError');
        },
        entries: async function* () {
          for (const k of Object.keys(tree)) {
            yield [k, tree[k] instanceof File
              ? { kind: 'file', getFile: async () => tree[k] }
              : makeHandle(tree[k])];
          }
        }
      };
    }
    window.showDirectoryPicker = async () => makeHandle({
      'images': { 'demo.png': F('demo.png') },
      'shared': { 'top.png': F('top.png') },
      'pic name.png': F('pic name.png'),
      'pic.png': F('pic.png')
    });
  });
  await page.click('#img-banner-btn');
  await new Promise(r => setTimeout(r, 600));
  report('授权后图片解析为 blob 地址显示', await page.evaluate(() => {
    const img = document.querySelector('#editor img');
    return img && img.getAttribute('src').startsWith('blob:');
  }));
  report('全部解析后提示条隐藏', await page.evaluate(() =>
    document.getElementById('img-banner').classList.contains('hidden')
  ));
  report('解析后保存仍写回原始路径', await page.evaluate(() => {
    const md = window.Wysiwyg.getMarkdown();
    return md.includes('![测试图](images/demo.png)') && !md.includes('blob:');
  }));

  /* 18. 刁钻路径：query / 大小写 / ../ / 编码空格 / 授权层级选错的文件名兜底 */
  await page.evaluate(() => {
    window.Wysiwyg.setMarkdown(
      '![q](images/demo.png?raw=true)\n\n' +
      '![c](images/DEMO.PNG)\n\n' +
      '![u](../shared/top.png)\n\n' +
      '![e](pic%20name.png)\n\n' +
      '![b](deep/nested/pic.png)\n\n' +      /* 完整路径失败 → 授权根按文件名兜底 */
      '![s](wrongprefix/top.png)\n'          /* → 一层子目录按文件名兜底 */
    );
  });
  await new Promise(r => setTimeout(r, 800));
  report('query/大小写/../编码空格/兜底 图片全部解析', await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('#editor img'));
    return imgs.length === 6 && imgs.every(i => i.getAttribute('src').startsWith('blob:'));
  }));
  report('刁钻路径保存仍写回原始字符串', await page.evaluate(() => {
    const md = window.Wysiwyg.getMarkdown();
    return md.includes('![q](images/demo.png?raw=true)') &&
           md.includes('![c](images/DEMO.PNG)') &&
           md.includes('![u](../shared/top.png)') &&
           md.includes('![e](pic%20name.png)') &&
           md.includes('![b](deep/nested/pic.png)') &&
           md.includes('![s](wrongprefix/top.png)') &&
           !md.includes('blob:');
  }));

  /* 19. 快照式撤销/恢复 */
  await page.evaluate(() => {
    window.Wysiwyg.setMarkdown('# 撤销测试\n\n占位\n');
    const ed = document.getElementById('editor');
    ed.focus();
    const p = ed.querySelector('p');
    const r = document.createRange();
    r.selectNodeContents(p); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.keyboard.type('第一段文字');
  await new Promise(r => setTimeout(r, 600));
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await new Promise(r => setTimeout(r, 200));
  report('Ctrl+Z 撤销输入', await page.evaluate(() =>
    !document.getElementById('editor').textContent.includes('第一段文字') &&
    !!document.querySelector('#editor h1')
  ));
  await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control');
  await new Promise(r => setTimeout(r, 200));
  report('Ctrl+Y 恢复输入', await page.evaluate(() =>
    document.getElementById('editor').textContent.includes('第一段文字')
  ));
  /* 手动 DOM 操作（自动格式化）也可撤销——原生栈做不到的场景 */
  await page.keyboard.type('**加粗**');
  await new Promise(r => setTimeout(r, 600));
  report('自动格式化生效待撤销', await page.evaluate(() => {
    const st = document.querySelector('#editor strong');
    return st && st.textContent === '加粗';
  }));
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await new Promise(r => setTimeout(r, 200));
  report('Ctrl+Z 撤销自动格式化（手动 DOM 操作）', await page.evaluate(() =>
    !document.querySelector('#editor strong') &&
    document.getElementById('editor').textContent.includes('第一段文字')
  ));
  /* 工具栏命令可撤销 */
  await page.evaluate(() => window.Wysiwyg.execCommand('h2'));
  await new Promise(r => setTimeout(r, 600));
  report('工具栏命令生效待撤销', await page.evaluate(() => {
    const h = document.querySelector('#editor h2');
    return h && h.textContent.includes('第一段文字');
  }));
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await new Promise(r => setTimeout(r, 200));
  report('Ctrl+Z 撤销工具栏命令', await page.evaluate(() =>
    !document.querySelector('#editor h2') &&
    document.getElementById('editor').textContent.includes('第一段文字')
  ));
  /* 文档加载边界 */
  await page.evaluate(() => { window.Wysiwyg.setMarkdown('# 新文档\n'); });
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await new Promise(r => setTimeout(r, 200));
  report('撤销不跨越文档加载边界', await page.evaluate(() =>
    document.getElementById('editor').textContent.includes('新文档')
  ));
  /* 撤销后再输入应截断"未来"分支，redo 失效 */
  await page.evaluate(() => {
    const ed = document.getElementById('editor');
    ed.focus();
    const p = ed.querySelector('p') || ed.appendChild(document.createElement('p'));
    const r = document.createRange();
    r.selectNodeContents(p); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  await page.keyboard.type('abc');
  await new Promise(r => setTimeout(r, 600));
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await new Promise(r => setTimeout(r, 150));
  await page.keyboard.type('xyz');
  await new Promise(r => setTimeout(r, 600));
  await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control');
  await new Promise(r => setTimeout(r, 200));
  report('撤销后新输入截断 redo 分支', await page.evaluate(() => {
    const t = document.getElementById('editor').textContent;
    return t.includes('xyz') && !t.includes('abc');
  }));

  /* 20. 专注/打字机模式 */
  await page.evaluate(() => {
    const cb = document.getElementById('set-focus');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
  });
  report('专注模式开启（body 类名）', await page.evaluate(() =>
    document.body.classList.contains('focus-mode')
  ));
  await page.evaluate(() => {
    window.Wysiwyg.setMarkdown('# A\n\n第一段\n\n第二段\n');
    const ed = document.getElementById('editor');
    ed.focus();
    const ps = ed.querySelectorAll('p');
    const r = document.createRange();
    r.setStart(ps[1].firstChild, 1); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await new Promise(r => setTimeout(r, 400));
  report('专注模式仅当前块保持高亮', await page.evaluate(() => {
    const cur = document.querySelectorAll('#editor > .focus-current');
    return cur.length === 1 && cur[0].textContent === '第二段';
  }));
  /* 打字机模式：长文档点击尾部段落 → 滚动到视口中部 */
  await page.evaluate(() => {
    const cb = document.getElementById('set-typewriter');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    let md = '';
    for (let i = 1; i <= 30; i++) md += '第 ' + i + ' 段\n\n';
    window.Wysiwyg.setMarkdown(md);
    const ed = document.getElementById('editor');
    document.getElementById('editor-scroll').scrollTop = 0;
    ed.focus();
    const ps = ed.querySelectorAll('p');
    const last = ps[ps.length - 1];
    const r = document.createRange();
    r.setStart(last.firstChild, 1); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await new Promise(r => setTimeout(r, 900));
  report('打字机模式滚动光标块到视口中部', await page.evaluate(() =>
    document.getElementById('editor-scroll').scrollTop > 100
  ));
  await page.evaluate(() => {
    const f = document.getElementById('set-focus');
    f.checked = false; f.dispatchEvent(new Event('change'));
    const t = document.getElementById('set-typewriter');
    t.checked = false; t.dispatchEvent(new Event('change'));
  });

  /* 21. 查找替换 */
  await page.evaluate(() => {
    window.Wysiwyg.setMarkdown('# 查找测试\n\n苹果 香蕉 苹果 橘子\n\n代码里的苹果\n');
  });
  await page.keyboard.down('Control'); await page.keyboard.press('f'); await page.keyboard.up('Control');
  await new Promise(r => setTimeout(r, 200));
  report('Ctrl+F 打开查找条', await page.evaluate(() =>
    !document.getElementById('find-bar').classList.contains('hidden')
  ));
  await page.type('#find-input', '苹果');
  await new Promise(r => setTimeout(r, 300));
  report('查找匹配计数正确', await page.evaluate(() =>
    document.getElementById('find-count').textContent === '1/3'
  ));
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 150));
  report('Enter 跳转下一个匹配', await page.evaluate(() =>
    document.getElementById('find-count').textContent === '2/3'
  ));
  await page.click('#find-toggle-replace');
  await page.type('#replace-input', '西瓜');
  await page.click('#replace-one');
  await new Promise(r => setTimeout(r, 250));
  report('替换当前匹配', await page.evaluate(() => {
    const t = document.getElementById('editor').textContent;
    return t.includes('西瓜') && (t.match(/苹果/g) || []).length === 2;
  }));
  await page.click('#replace-all');
  await new Promise(r => setTimeout(r, 250));
  report('全部替换', await page.evaluate(() => {
    const t = document.getElementById('editor').textContent;
    return !t.includes('苹果') && (t.match(/西瓜/g) || []).length === 3;
  }));
  report('替换结果进入 Markdown 序列化', await page.evaluate(() =>
    window.Wysiwyg.getMarkdown().includes('西瓜 香蕉 西瓜 橘子')
  ));
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.getElementById('editor').focus());
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await new Promise(r => setTimeout(r, 300));
  report('替换可被 Ctrl+Z 撤销', await page.evaluate(() =>
    document.getElementById('editor').textContent.includes('苹果')
  ));

  /* 22. 末尾再验一次页面错误 */
  report('全程无 JS 运行时错误', consoleErrors.length === 0, consoleErrors.join('\n'));

  await browser.close();
  srv.close();
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
