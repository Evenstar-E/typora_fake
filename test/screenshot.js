/* 截图脚本：生成应用界面预览图 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const PORT = 8892;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8'
};

(async () => {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    fs.readFile(path.normalize(path.join(ROOT, p)), (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(data);
    });
  }).listen(PORT);

  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1.5']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#editor .math-block .katex', { timeout: 10000 });
  await new Promise(r => setTimeout(r, 600));
  await page.screenshot({ path: path.join(ROOT, 'screenshot-light.png') });

  /* 夜间主题 */
  await page.select('#set-theme', 'night');
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: path.join(ROOT, 'screenshot-night.png') });

  await browser.close();
  srv.close();
  console.log('screenshots saved');
})().catch(e => { console.error(e); process.exit(1); });
