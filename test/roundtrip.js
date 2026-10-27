/* ============================================================
 * 往返测试：Markdown → 渲染 HTML → 序列化回 Markdown
 * 运行：node test/roundtrip.js
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

/* ---------- 搭建 jsdom 全局环境 ---------- */
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.NodeFilter = dom.window.NodeFilter;
global.HTMLElement = dom.window.HTMLElement;

/* ---------- 加载第三方库 ---------- */
const markdownit = require('../vendor/markdown-it.min.js');
const katex = require('../vendor/katex/katex.min.js');
const hljs = require('../vendor/highlight/highlight.min.js');

/* turndown dist 是全局 IIFE，用间接 eval 注入全局 */
(0, eval)(fs.readFileSync(path.join(__dirname, '../vendor/turndown.js'), 'utf8'));
require('../vendor/turndown-plugin-gfm.js'); // 挂到 window.turndownPluginGfm

/* ---------- 加载应用模块 ---------- */
require('../js/md.js');
require('../js/serialize.js');

const mdKit = window.MdKit.create({ markdownit, katex, hljs });
const serializer = window.SerializeKit.create({
  TurndownService: globalThis.TurndownService,
  gfm: window.turndownPluginGfm
});

/* ---------- 测试用例 ---------- */
let passed = 0, failed = 0;

function check(name, md, expectations) {
  const html = mdKit.render(md);
  const out = serializer.toMarkdown(html);
  const misses = expectations.filter(e => !out.includes(e));
  if (misses.length === 0) {
    passed++;
    console.log('✓ ' + name);
  } else {
    failed++;
    console.log('✗ ' + name);
    console.log('  输入:\n    ' + md.replace(/\n/g, '\n    '));
    console.log('  输出:\n    ' + out.replace(/\n/g, '\n    '));
    console.log('  缺少: ' + JSON.stringify(misses));
  }
}

check('标题与行内格式',
'# 一级标题\n\n## 二级标题\n\n这是 **加粗** 和 *斜体* 和 ~~删除线~~ 和 `行内代码`。\n',
['# 一级标题', '## 二级标题', '**加粗**', '*斜体*', '~~删除线~~', '`行内代码`']);

check('列表',
'- 苹果\n- 香蕉\n  - 子项\n\n1. 第一\n2. 第二\n',
['- 苹果', '- 香蕉', '- 子项', '1. 第一', '2. 第二']);

check('任务列表',
'- [ ] 未完成\n- [x] 已完成\n',
['- [ ] 未完成', '- [x] 已完成']);

check('表格',
'| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n| 香蕉 | 5 |\n',
['| 名称 | 数量 |', '| 苹果 | 3 |']);

/* PDF 转换的宽容表格：缺分隔行 + em-dash 占位（Obsidian 式修复） */
check('PDF表格(缺分隔行+em-dash)',
'| 数据集 | 稠密成对 MC |\n| — | — |\n| 25.0% | 稠密成对 MC |\n| 33.3% | 稀疏成对 MC |\n',
['| 数据集 | 稠密成对 MC |', '| 25.0% |']);

/* PDF 转换的宽容表格：完全无分隔行 */
check('PDF表格(无分隔行)',
'| Intel Lab | 0.002 |\n| Killian Court | 0.006 |\n',
['| Intel Lab | 0.002 |', '| Killian Court |']);

/* PDF 断行：无前导管道的行拼接回上一行 */
check('PDF表格(断行拼接)',
'| A | B |\n| --- | --- |\n| 87.5% | Intel Lab |\n0.139 | Killian Court |\n',
['| 87.5% | Intel Lab |']);

/* 列数不齐自动对齐（补空单元格） */
check('PDF表格(列数对齐)',
'| A | B |\n| --- | --- |\n| 1 | 2 | 3 | 4 |\n',
['| A | B |', '| 1 | 2 |']);

check('行内公式',
'质能方程 $E = mc^2$ 与欧拉公式 $e^{i\\pi}+1=0$。\n',
['$E = mc^2$', '$e^{i\\pi}+1=0$']);

check('公式块',
'$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$\n',
['$$', '\\int_0^1 x^2 \\, dx = \\frac{1}{3}']);

check('错误公式容错（保留源码）',
'公式 $\\badcommand{x}$ 保留源码。\n',
['$\\badcommand{x}$']);

check('代码块（带语言）',
'```javascript\nconst x = 42;\nconsole.log(x);\n```\n',
['```javascript', 'const x = 42;']);

check('行内 HTML 标签',
'这是 <u>下划线</u> 和 <mark>高亮</mark> 和 H<sub>2</sub>O。\n',
['<u>下划线</u>', '<mark>高亮</mark>', 'H<sub>2</sub>O']);

check('HTML 块（details）',
'<details>\n<summary>展开</summary>\n\n折叠里的 **内容**。\n\n</details>\n',
['<details>', '<summary>展开</summary>', '</details>']);

check('链接与图片',
'[示例](https://example.com) 与 ![描述](https://example.com/a.png)\n',
['[示例](https://example.com)', '![描述](https://example.com/a.png)']);

check('引用与分割线',
'> 引用一段文字\n>\n> 第二段\n\n---\n',
['> 引用一段文字', '> 第二段', '---']);

check('字面量特殊字符转义',
'价格 100 * 2 = 200，还有 [括号] 与 # 号。\n',
['100 \\* 2', '\\[括号\\]', '# 号']);

/* 图片 data-src 保真：显示层 src 被换成 blob 时，保存仍写回原始路径 */
(function () {
  const html = '<p><img src="blob:http://localhost/fake-uuid" data-src="assets/pic.png" alt="示例图"></p>';
  const out = serializer.toMarkdown(html);
  if (out.includes('![示例图](assets/pic.png)') && !out.includes('blob:')) {
    passed++;
    console.log('✓ 图片 data-src 保真（blob 地址不写入文件）');
  } else {
    failed++;
    console.log('✗ 图片 data-src 保真\n  输出: ' + out);
  }
})();

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
