/* 零依赖静态文件服务器：node server.js [端口]
 * 附带 /api/ai：调用本机 Claude Code CLI（claude -p 无头模式）的流式写作助手端点 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.argv[2], 10) || 8899;
const ROOT = __dirname;

/* 写作助手场景下禁止 agent 使用任何工具（只产出文本，不碰文件/网络） */
const AI_DISALLOWED_TOOLS = [
  'Task', 'Artifact', 'ArtifactComments', 'ArtifactData', 'Bash', 'CronCreate',
  'CronDelete', 'CronList', 'DesignSync', 'Edit', 'Glob', 'Grep', 'Monitor',
  'NotebookEdit', 'PowerShell', 'Read', 'WebFetch', 'WebSearch', 'Write'
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8'
};

/* ---------------- AI 端点 ---------------- */

function sseWrite(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

function handleAI(req, res) {
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 128 * 1024) req.destroy();
  });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad json' }));
      return;
    }
    const instruction = String(payload.instruction || '').slice(0, 2000);
    const text = String(payload.text || '').slice(0, 12000);
    if (!instruction.trim() || !text.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'instruction 与 text 不能为空' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache'
    });

    /* 测试桩：MARKLITE_AI_MOCK=1 时不调真实 CLI */
    if (process.env.MARKLITE_AI_MOCK) {
      const fake = '这是对「' + instruction.slice(0, 20) + '」的模拟 AI 输出。\n\n原文共 ' + text.length + ' 字。';
      let i = 0;
      const timer = setInterval(() => {
        i += 5;
        sseWrite(res, { text: fake.slice(0, i) });
        if (i >= fake.length) {
          clearInterval(timer);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 25);
      /* 注意：必须是 res 的 close（响应断开）；req 的 close 在 body 读完即触发 */
      res.on('close', () => clearInterval(timer));
      return;
    }

    const prompt =
      '你是 MarkLite Markdown 编辑器内置的写作助手。请对给定的 Markdown 内容执行用户指令，' +
      '直接输出处理后的 Markdown 文本本身：不要输出解释、前言或后缀，不要用代码围栏包裹全文。\n\n' +
      '【用户指令】\n' + instruction + '\n\n【Markdown 内容】\n' + text;

    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--disallowedTools', ...AI_DISALLOWED_TOOLS
    ];
    /* Windows 上 claude 是 .cmd 包装，需要 shell；参数均为固定值，无注入面 */
    const proc = spawn(process.platform === 'win32' ? 'claude.cmd' : 'claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    });

    let lastText = '';
    let buf = '';
    let errBuf = '';
    let finished = false;

    function done() {
      if (finished) return;
      finished = true;
      res.write('data: [DONE]\n\n');
      res.end();
    }

    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch (e) { continue; }
        if (ev.type === 'system' && ev.subtype === 'thinking_tokens') {
          sseWrite(res, { thinking: ev.estimated_tokens });
        } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
          const t = ev.message.content
            .filter((b) => b && b.type === 'text' && b.text)
            .map((b) => b.text).join('');
          if (t && t !== lastText) {
            lastText = t;
            sseWrite(res, { text: t });
          }
        } else if (ev.type === 'result') {
          if (!lastText && ev.result) sseWrite(res, { text: String(ev.result) });
          if (ev.total_cost_usd !== undefined) sseWrite(res, { cost: ev.total_cost_usd });
        }
      }
    });
    proc.stderr.on('data', (c) => { errBuf += c.toString('utf8'); });
    proc.stdin.on('error', (e) => { console.error('[ai] stdin error:', e.message); });
    proc.on('error', (e) => {
      console.error('[ai] proc error:', e.message);
      sseWrite(res, { error: '无法启动 claude CLI（未安装或不在 PATH）：' + e.message });
      done();
    });
    proc.on('close', (code) => {
      if (!lastText && errBuf) {
        sseWrite(res, { error: 'claude 退出码 ' + code + '：' + errBuf.slice(-400) });
      }
      done();
    });
    /* 响应中断（用户点了停止）→ 杀掉 CLI 进程 */
    res.on('close', () => {
      if (!finished) { try { proc.kill(); } catch (e) {} }
    });

    /* prompt 走 stdin，避开 Windows 命令行长度限制 */
    proc.stdin.write(prompt, 'utf8');
    proc.stdin.end();
  });
}

/* ---------------- 静态服务 ---------------- */

http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);

  if (req.method === 'POST' && urlPath === '/api/ai') {
    handleAI(req, res);
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found: ' + urlPath);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`MarkLite 已启动:  http://localhost:${PORT}`);
  console.log('AI 写作助手端点: POST /api/ai（调用本机 claude CLI）');
  console.log('按 Ctrl+C 停止');
});
