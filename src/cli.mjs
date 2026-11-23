#!/usr/bin/env node
// CLI 智能体界面（类 Claude Code）
import readline from 'node:readline';
import { agentChat, cfg } from './agent.mjs';

console.log(`
╔══════════════════════════════════════════════╗
║  ⚡ 超算低效作业识别智能体  hpc-agent v0.1     ║
║  SJTU HPC · 交我创大赛 · 组委命题四            ║
╚══════════════════════════════════════════════╝
命令: /help 帮助 · /clear 清空对话 · /quit 退出
`);
if (!cfg.baseUrl || !cfg.apiKey) {
  console.log('⚠️  未配置 LLM：在项目根 .env 填入 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL\n');
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, r));
let history = [];

async function runTurn(userMsg) {
  process.stdout.write('\n');
  let gotText = false;
  for await (const ev of agentChat(history, userMsg, {
    onTool: ({ name, args }) => process.stdout.write(`\n  🔧 ${name}(${JSON.stringify(args).slice(0, 120)})\n`),
  })) {
    if (ev.type === 'text') {
      if (!gotText) process.stdout.write('\n');
      process.stdout.write(ev.text);
      gotText = true;
    }
  }
  process.stdout.write('\n');
  history.push({ role: 'user', content: userMsg }, { role: 'assistant', content: '(见终端输出)' });
  if (history.length > 20) history = history.slice(-20);
}

const HELP = `示例问法：
  · 最近7天集群整体情况怎么样？
  · 超时最严重的 10 个作业是哪些？
  · 作业 #12345678 详情
  · 哪个用户消耗核时最多？
  · 给超时最严重的那个作业生成一个终止工单
  · 排队超过 4 小时的作业有哪些？`;

while (true) {
  let line;
  try { line = await ask('\n你 > '); } catch { break; }
  line = line.trim();
  if (!line) continue;
  if (line === '/quit' || line === '/exit') break;
  if (line === '/clear') { history = []; console.log('对话已清空'); continue; }
  if (line === '/help') { console.log(HELP); continue; }
  try { await runTurn(line); } catch (e) { console.error('❌ ' + e.message); }
}
console.log('再见 👋');
rl.close();
