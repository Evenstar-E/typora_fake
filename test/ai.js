/* ============================================================
 * AI 面板端到端测试（MARKLITE_AI_MOCK 桩，走真实 server.js + /api/ai）
 * 运行：node test/ai.js
 * ============================================================ */
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const PORT = 8898;

let passed = 0, failed = 0;
function report(name, ok, extra) {
  if (ok) { passed++; console.log('✓ ' + name); }
  else { failed++; console.log('✗ ' + name + (extra ? '\n    ' + extra : '')); }
}

function findBrowser() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'
  ];
  return candidates.find(p => fs.existsSync(p));
}

(async () => {
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(PORT)], {
    env: Object.assign({}, process.env, { MARKLITE_AI_MOCK: '1' }),
    stdio: 'ignore'
  });
  await new Promise(r => setTimeout(r, 800));

  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));

  try {
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForSelector('#editor h1', { timeout: 10000 });

    /* 1. 打开 AI 面板 */
    await page.click('#btn-ai');
    report('✨ 按钮打开 AI 面板', await page.evaluate(() =>
      !document.getElementById('ai-panel').classList.contains('hidden')
    ));

    /* 2. 准备文档并选中一段文字 */
    await page.evaluate(() => {
      window.Wysiwyg.setMarkdown('# AI 测试\n\n这是一段待处理的原文。\n');
      const ed = document.getElementById('editor');
      ed.focus();
      const p = ed.querySelector('p');
      const r = document.createRange();
      r.selectNodeContents(p);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });

    /* 3. 快捷指令：润色（mock 流式返回） */
    await page.click('.ai-chip'); /* 第一个 chip = 润色 */
    await page.waitForFunction(() =>
      document.getElementById('ai-output').textContent.includes('模拟 AI 输出'),
      { timeout: 8000 }
    );
    report('快捷指令经 /api/ai 流式返回结果', true);
    await page.waitForFunction(() =>
      document.getElementById('ai-send').disabled === false,
      { timeout: 8000 }
    );
    report('流结束后发送按钮恢复可用', true);

    /* 4. 替换选区 */
    await page.click('#ai-replace');
    await new Promise(r => setTimeout(r, 400));
    report('替换选区生效', await page.evaluate(() => {
      const t = document.getElementById('editor').textContent;
      return t.includes('模拟 AI 输出') && !t.includes('待处理的原文');
    }));
    report('替换结果可序列化', await page.evaluate(() =>
      window.Wysiwyg.getMarkdown().includes('模拟 AI 输出')
    ));

    /* 5. 插入光标处（再来一份；等待超过防抖周期确保 1 份状态已压栈） */
    await new Promise(r => setTimeout(r, 700));
    await page.click('#ai-insert');
    await new Promise(r => setTimeout(r, 400));
    report('插入光标处生效', await page.evaluate(() => {
      const t = document.getElementById('editor').textContent;
      return (t.match(/模拟 AI 输出/g) || []).length >= 2;
    }));

    /* 6. 插入操作可走快照撤销 */
    await page.evaluate(() => document.getElementById('editor').focus());
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    await new Promise(r => setTimeout(r, 300));
    report('AI 插入可被 Ctrl+Z 撤销', await page.evaluate(() =>
      (document.getElementById('editor').textContent.match(/模拟 AI 输出/g) || []).length === 1
    ));

    /* 7. 报告场景回归：先选中 → 再开面板（焦点进输入框销毁选区）→ 仍应使用选区 */
    await page.evaluate(() => {
      document.getElementById('ai-panel').classList.add('hidden');
      window.Wysiwyg.setMarkdown('# 选区测试\n\n需要润色的句子。\n');
      const ed = document.getElementById('editor');
      ed.focus();
      const p = ed.querySelector('p');
      const r = document.createRange();
      r.selectNodeContents(p);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.click('#btn-ai'); /* 打开面板，焦点进入指令输入框 */
    report('开面板后编辑器选区确实已失（复现前提）', await page.evaluate(() => {
      const s = getSelection();
      return s.isCollapsed || !s.toString();
    }));
    await page.click('.ai-chip');
    await page.waitForFunction(() =>
      document.getElementById('ai-output').textContent.includes('原文共') &&
      !document.getElementById('ai-send').disabled,
      { timeout: 8000 }
    );
    report('选区上下文未被焦点销毁（字数=选区而非全文）', await page.evaluate(() =>
      document.getElementById('ai-output').textContent.includes('原文共 8 字')
    ), await page.evaluate(() => document.getElementById('ai-output').textContent));
    await page.click('#ai-replace');
    await new Promise(r => setTimeout(r, 400));
    report('替换选区在开面板后仍准确替换原选中句', await page.evaluate(() => {
      const t = document.getElementById('editor').textContent;
      return t.includes('模拟 AI 输出') && !t.includes('需要润色的句子');
    }));

    report('全程无 JS 运行时错误', consoleErrors.length === 0, consoleErrors.join('\n'));
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
