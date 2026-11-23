# 📋 会话交接摘要（SESSION HANDOVER）

> 新会话：读完本文件即可接手本项目。所有关键上下文、凭据位置、坑位、前端架构都在这。
> 最近更新：前端交互完善（停止/队列/模型选择器/动态候选/30天窗口）+ 后端健壮性（网络重试/防重复工具/职责边界）+ 部署事实修正。

## 1. 项目是什么

**超算低效作业识别智能体（HPC Waste Agent）** —— "交我创"智能体创新大赛组委命题四参赛作品。
- 数据源：SJTU HPC 集群 SLURM API（`api.hpc.sjtu.edu.cn`，已脱敏）
- LLM：致远一号（交大校内 `models.sjtu.edu.cn`，OpenAI 兼容）
- 形态：CLI + Web 对话式 Agent，工具调用查数 → 确定性分析 → 高危操作只出工单

## 2. 部署位置（重要）

| 位置 | 内容 | 状态 |
|---|---|---|
| **服务器** `wuyinghao@218.193.182.103`（SSH 端口 **8462**）`~/Desktop/hpc_agent/` | 运行主体 + 数据 | **Web 服务运行中 :8899** |
| **本地** `C:\Users\LENOVO\Desktop\hpc_agent\` | 代码母版 + 文档（另一台机器） | 手动 scp 同步 |

> ⚠️ **Dela 会话注意**：本项目的 Dela 会话**直接连到 Linux 服务器**（`wuyinghao@yingyu`），
> bash/read/edit 都在服务器本地执行，**不需要再 ssh 回去**。HANDOVER 旧版"本地 Windows = 本 Dela 项目目录"
> 的说法只对纯本地会话成立，远程会话里 Windows 路径不存在。

- **Node 运行时**：`~/.local/bin/node`（v24.18.0，系统级，`which node` 可见）。
  旧版提到的 `runtime/bin/node`（v20 自包含）**已不存在**，别用那个路径。
  比赛"不污染系统环境"的要求如需恢复，再单独搞自包含 runtime。
- **数据**：`data/jobs_YYYYMMDD.jsonl`，**66 个文件，2026-05-04 ~ 2026-11-21**（按提交日分桶，62 万条，约 238MB）。
  文件不是每天连续——集群不是每天都有新提交，空缺日多是当天无作业（不是漏拉）。
  `/api/analysis?days=N` 和 agent 的 `days` 参数是**分析窗口**，支持 **1~30 天**，默认 7。
  数据已覆盖 30 天，**无需为 30 天窗口额外拉新**。
- **Web 访问**：服务器本地 `http://127.0.0.1:8899`；外网需 SSH 端口转发
  `ssh -N -L 8899:127.0.0.1:8899 -p 8462 wuyinghao@218.193.182.103`，浏览器开 `http://127.0.0.1:8899`。
- **工单**：`data/tickets/tickets.jsonl`（已 17 条，状态"待人工确认"）。

## 3. 凭据（都在文件里，别硬编码进新代码）

- **HPC API**：`src/hpc_client.mjs` 头部 CREDS（domain=jaccount, operator=wuying.hao）
- **LLM API**：`.env`（LLM_BASE_URL / LLM_API_KEY / **LLM_MODEL=qwen**）
- **SSH**：`ssh -p 8462 wuyinghao@218.193.182.103`（BatchMode 免密；scp 同参数）

## 4. 已知大坑（踩过的）

1. **HPC API 时间窗 ≤ 1 小时**：`fetch_jobs.mjs` 按 50min 切片；单片超时自动对半拆（`hpc_client.mjs` 的 `apiChunked`），最小 10min
2. **CPU 秒记账全为 0**：当前集群 API 返回的 `time.user/system` 全是 0，CPU 利用率类规则（low_cpu/mem_hog）自动降级为 0 命中，**不要硬编利用率**；改用 TIMEOUT 超时 / 长尾运行 / 排队 / 反复失败 信号。分析引擎已内置 `cpuSecAvailable` 检测自动降级
3. **LLM API 的 curl 抽风**：`models.sjtu.edu.cn` 用 curl 发请求会随机报 `model=None` 400（HTTP/2 相关），**用 node fetch 则 100% 正常**。测试 API 用 node 脚本别用 curl
4. **LLM 模型名**：用 `qwen`（`deepseek-chat` 也可）；调用名以 `/v1/models` 返回的 id 为准
5. **服务器 nohup 启动**：直接 `ssh host 'nohup ... &'` 会被 pkill -f 误杀自己，用 `ssh host 'bash -s' <<'REMOTE'` heredoc 方式
6. **API 配额**：LLM 每分钟 20 请求；HPC API 切片间隔 200ms 防限流
7. **⭐ Node http 流式 write 缓冲（本轮踩的）**：`res.write` 的小数据会攒在内部缓冲，
   **同一事件循环 tick 内的连续 write 不立即 flush 到 socket**。表现：工具执行期间（几秒~十几秒）
   `narrate`/`batch_start` 事件卡住不发，前端"正在运行"显示不出来，等工具跑完才一起涌出。
   **修复**：`server.mjs` 每次 `res.write` 后 `await new Promise(setImmediate)`（让出事件循环强制 flush）。
   改流式接口时别删这行。
8. **pkill -f 自杀**：在服务器 bash 里 `pkill -f "src/server.mjs"` 或命令行含该字面量时，
   会把自己的 bash 也匹配杀掉。重启 server 用 `ss -ltnp | grep :8899` 拿 PID 精确 kill，
   或 `pgrep` 后按 `/proc/PID/cwd` 过滤（见 §7 重启命令）。
9. **LLM 网络瞬时抖动（`fetch failed`）**：服务器到 `models.sjtu.edu.cn` 偶尔连接瞬断，
   表现为前端干等很久后显示“（无回复）”。**已修**：`agent.mjs` 的 `llmFetch` 对网络层错误
   （fetch failed/超时）自动重试 2 次（间隔递增）+ 120s 超时保护，重试仍失败则 yield 明确错误提示
   （不再显示干巴巴的“无回复”）。HTTP 错误（4xx/5xx）不重试。看到“❌ 连接模型服务失败”就是网络瞬断，稍后重发即可。

## 5. 代码结构（`src/` + `web/`）

```
src/hpc_client.mjs  API 客户端：token 缓存、重试、50min 切片、失败对半拆
src/fetch_jobs.mjs  数据管道 CLI：增量拉取 → data/jobs_YYYYMMDD.jsonl（按提交日分桶）
src/analyze.mjs     确定性分析引擎（非 LLM）：6 类低效规则 + 浪费核时 + 降级逻辑
src/agent.mjs       ReAct Agent 核心（async generator）：
                    · LLM 流式调用（stream:true，边收 SSE delta 边 yield text）
                    · llmFetch 带重试（网络抖动 fetch failed 自动重试 2 次 + 120s 超时）
                    · 防重复工具：calledSig 记录 (工具名+参数)，相同组合不重复执行、注入提示
                    · 工具批处理：一轮多个 tool_calls 用 batch_start/batch_end 包裹
                    · 事件类型：text / narrate / batch_start / batch_end / tool_done / suggest
                    · suggest：主回复完成后 genSuggestions 生成 4 个跟进问题（失败静默跳过）
                    · 5 工具：cluster_overview / top_wasters / job_detail / user_report / create_ticket
                    · 支持 model 参数（前端选模型，缺省 cfg.model）
                    · system prompt：职责边界（拒范围外请求、温和拉回正题）
                      + 第7条（调工具前说完整句引入）+ 第8条（时间窗口 1~30 天，明确口径）
src/cli.mjs         命令行交互
src/server.mjs      Web :8899：/api/chat（NDJSON 流）+ /api/analysis + 静态页
                    · /api/chat 转发 6 类事件（含 suggest），每次 write 后 await setImmediate 强制 flush
                    · clientGone 检测（客户端断开停写）+ 全局 uncaughtException 兜底（不杀进程）
                    · 接 model 字段传给 agentChat
web/index.html      单页前端（详见 §5.1）
```

**安全红线（比赛规则）**：suspend/terminate/quota/contact_user 只走 `create_ticket` 生成工单落盘
`data/tickets/tickets.jsonl`（状态"待人工确认"），**绝不直接执行**。system prompt 里已写死。

### 5.1 前端架构（web/index.html，单文件，无外部依赖）

**布局**：左对话 + 右低效清单仪表盘。深色/浅色双主题。

**主题**：
- 所有颜色走 CSS 变量，`<html data-theme="light">` 覆盖一套浅色变量
- header 右侧 🌙/☀️ 按钮切换，`localStorage.theme` 记忆
- `<head>` 内联脚本在渲染前设好主题（无闪烁）
- 图标语义：显示**当前**主题（深色=🌙，浅色=☀️）

**对话消息渲染（核心，本轮重构）**：
- AI 气泡由若干**段（segment）**从上到下堆叠，两类：
  - **回复段** `.textseg`：纯 markdown，永远展开
  - **工具批次段** `.batchseg`：折叠块
- **工具批次段**结构（两层）：
  - **块头**（始终可见，可点击折叠/展开）：状态图标 + 当前行 `.seg-cur` + chevron
    - 进行中：`⟳ 正在运行：{narrate}`（暖色 + spinner）
    - 完成：`✅ 调用了 N 个工具`
  - **明细区** `.seg-detail`（默认 `collapsed` 收起）：所有条目历史，**全灰色**
    - 进行中标"正在运行：…"，完成改"已运行：…"
- **事件 → DOM 映射**（send 循环）：
  - `text` → 追加到当前回复段（80ms 节流重渲染 markdown）
  - `batch_start` → `curText=null`（让"让我…"引入句单独成段）+ 新建批次段
  - `narrate` → `batchItemStart`：块头当前行切到新条 + 明细区追加灰色行
  - `tool` → `batchItemDone`：明细区该条改"已运行"
  - `batch_end` → `setBatchDone`：块头变"✅ 调用了 N 个工具" + `curText=null`
- **DOM 安全**：markdown 只重设 `.seg-body`，`.seg-cur`/明细区是独立节点，**绝不被 innerHTML 覆盖**
  （早期版本用 `bubble.innerHTML=` 重设会销毁 tools/narrate 节点，导致 `insertBefore not a child` 报错，已修）

**markdown 渲染**（`renderMarkdown` + `inlineMd`，自写无库）：
- 支持：标题/粗体/斜体/行内代码/围栏代码块/无序+有序列表/表格/引用/链接/图片/hr
- **表格**：连续 `|` 行合并成**一个** `<table>`（首行 thead），不是每行独立表
- 行内先 `esc` 转义再套标签，代码块用 `\x00CB` 占位保护

**输入与交互（本轮新增）**：
- **输入框**：`<textarea>`（非 input），支持 **Shift+Enter 换行**、Enter 发送；autoGrow 自适应高度（max 160px）
- **发送/停止按钮双态**：空闲=→箭头（黑底白框，浅色主题白底黑箭头）；进行中=■圆角矩形
  点停止 → `AbortController.abort()` 中断 fetch，已生成内容保留 + 尾部“⏹ 已停止”，不显示报错
- **消息队列**：请求进行中再发 → 不丢弃，进 `pendingQueue`（[{id,text}]）；
  输入框上方显示排队卡片（每条一行 + “撤销”按钮）；点撤销 → 消息**替换**回填输入框（连续撤销最后一次为准）；
  当前请求结束 → 自动发下一条；按钮全程可点（busy 时=停止，不靠 disabled）
- **模型选择器**（header `#modelSel`）：qwen(快)/deepseek-chat/deepseek-reasoner(思考)/qwen3.8-27b/claw，
  `localStorage.model` 记忆；请求带 `model` 字段，后端 agentChat 覆盖默认。
  **注意**：deepseek-reasoner 明显慢（思考+工具调用），演示别用它做实时问答
- **动态候选问题**：输入框上方快捷按钮区，初始 5 个预设；每轮回复收到 `suggest` 事件 →
  `setQuickItems` 重渲染为 LLM 生成的 4 个跟进问题（紧扣上下文）；空/失败则保留旧按钮

**右侧面板**：KPI 卡片（作业总数/排队浪费/失败浪费/P95）+ 低效规则 chips +
Top 超时/排队/反复失败/零CPU 表格（排名徽章金/银/铜、进度条、状态 pill）。
标题有 **7天/30天 切换**（`panelDays`，默认 30，事件委托，面板重建后仍有效）。

## 6. 实测结论（供比赛汇报）

**7 天窗口**：
- 14.4 万作业；COMPLETED 86.4%，FAILED 11.2%，TIMEOUT 1454 个
- **最大浪费：排队等待 ~360 亿核秒（千万级核时）**（queue_long 1.2 万个命中）
- 反复失败 327 组（同用户同作业名 ≥3 次）
- Top 超时：申请 2h 实际跑 120h（session_rstudio_16core）
- 用户维度：Top1 仅 39 个作业消耗 21.6 万核时

**30 天窗口**：
- 14.5 万作业（近 30 天），FAILED 约 10.4%，TIMEOUT 1526 个，排队浪费 ~361 亿核秒
- 作业主要集中在 `64c512g` 和 `cpu` 两个分区（合计约 94%）

Agent 实测：工具调用稳定、数字全部来自工具不编造、会主动声明数据局限、
高危操作正确走工单流程、拒绝范围外请求（温和拉回正题）✅
前端实测：流式逐字、工具批次“正在运行”实时滚动、停止/队列/模型选择/动态候选/30天切换、markdown 表格对齐、双主题 ✅

## 7. 常用命令（在服务器本地执行，Dela 远程会话直接跑）

```bash
cd ~/Desktop/hpc_agent

# 重启 Web 服务（精确 kill，避免 pkill -f 自杀）
node -e '
const { execSync, spawn } = require("child_process"); const fs = require("fs");
let pids=[];
try { const out=execSync("ss -ltnp 2>/dev/null | grep :8899 || true",{encoding:"utf8"});
  const m=out.match(/pid=(\d+)/g); if(m) pids=[...new Set(m.map(x=>+x.match(/\d+/)[0]))]; } catch{}
for(const p of pids){ try{process.kill(p,"SIGTERM");}catch{} }
setTimeout(()=>{
  const log=fs.openSync("data/server.log","w");
  const c=spawn(process.execPath,["src/server.mjs"],{cwd:process.cwd(),detached:true,
    stdio:["ignore",log,log],env:{...process.env,DATA_DIR:process.cwd()+"/data"}});
  c.unref(); setTimeout(()=>process.exit(0),800);
},800);'
sleep 1 && curl -s -o /dev/null -w "http %{http_code}\n" http://127.0.0.1:8899/

# 端到端测对话（看流式事件）
curl -sN -m 180 -X POST http://127.0.0.1:8899/api/chat \
  -H "Content-Type: application/json" -d '{"message":"最近7天集群整体情况？"}'

# 测 agent 事件序列（不经过 server，直接消费 generator）
node -e 'import("./src/agent.mjs").then(async({agentChat})=>{
  for await(const ev of agentChat([], "哪个用户消耗核时最多？"))
    console.log(ev.type, (ev.text||ev.name||"").slice(0,20));})'

# 拉新数据（后台，自动拆片重试）
nohup node src/fetch_jobs.mjs 7 > data/fetch.log 2>&1 &

# 语法检查（改完代码必做）
node --check src/agent.mjs && node --check src/server.mjs
node -e 'const h=require("fs").readFileSync("web/index.html","utf8");
  [...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((s,i)=>new Function(s[1]));
  console.log("frontend OK")'
```

> 改 `web/index.html` 后**无需重启**（静态文件每次请求读盘）；改 `src/*.mjs` 后**必须重启** server。

## 8. 待办（下一步）

- [ ] 比赛材料：README 初版已有，还差 架构图 / 演示脚本 / PPT
- [ ] 网页进阶：工单确认页（列出 data/tickets + 人工确认按钮）、用户排行页、趋势图
- [ ] 演示录屏
- [ ] 比赛提交格式确认（看 competition.md）
- [ ] 测 `claw` 和 `qwen3.8-27b` 的工具调用兼容性（用户选了它们若异常再查）
- [ ] 如需满足"不污染系统环境"，恢复自包含 Node runtime（当前用系统 ~/.local/bin/node v24）

**已完成（本轮）**：流式输出 / markdown 渲染 / 双主题 / 工具批次折叠（正在运行实时滚动）/
停止按钮 / 消息队列（可撤销）/ 模型选择器 / 动态候选问题 / 30 天窗口 + 7/30 切换 /
网络重试 / 防重复工具 / 职责边界（拒范围外请求）/ Shift+Enter 换行 / server 崩溃保护

## 9. 相关文档（同目录）

- `README.md` 项目总览
- `hpc-api-notes.md` HPC API 逆向笔记（token 接口、字段含义、坑）
- `competition.md` 比赛规则要点
- `agentsquare-api.md` / `tracks-detail.md` AgentSquare 与赛道说明
