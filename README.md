# ⚡ 超算低效作业识别智能体（HPC Waste Agent）

"交我创"智能体创新大赛 · 组委命题四参赛作品

基于 SJTU HPC 集群 API + 大模型（致远一号 qwen/deepseek）的
低效作业识别 Agent：自然语言问答 → 工具调用查数 → 确定性分析 → 高危操作只出工单。

## 架构
```
fetch_jobs.mjs   数据管道：SLURM 历史作业按 50min 切片拉取（失败自动对半拆）→ data/jobs_YYYYMMDD.jsonl
analyze.mjs      确定性分析引擎（非 LLM）：6 类低效规则 + 浪费核时估算
agent.mjs        ReAct 智能体核心：LLM 工具调用循环（OpenAI 兼容接口）
  tools:         cluster_overview / top_wasters / job_detail / user_report / create_ticket(工单)
cli.mjs          命令行交互界面
server.mjs       Web 服务 :8899（对话 NDJSON 流 + 低效清单面板）
web/index.html   单页前端（左对话 + 右实时清单）
```

## 低效识别规则
| 类别 | 规则 | 说明 |
|---|---|---|
| low_cpu | 利用率 < 15% 或 < 自身基线 30%（≥30min） | 需 cpu_sec 记账可用；当前集群该字段为 0，自动降级 |
| limit_abuse | 时限 ≥ 8h 且 > 5x 实际运行 | |
| queue_long | 排队 > max(分区 P90, 2h) | 当前集群最大浪费项（~千万核时） |
| repeat_fail | 同用户同作业名失败 ≥ 3 次/7天 | |
| mem_hog | 内存/核 > 8GB 且利用率 < 30% | 需 cpu_sec |
| 补充信号 | TIMEOUT 超时、长尾运行 | cpu_sec 缺失时的降级方案 |

## 安全设计（比赛红线）
- 暂停/终止/配额/联系用户 = 高危 → `create_ticket` 只生成工单落盘 `data/tickets/`，
  状态"待人工确认"，**绝不直接执行**
- 数据全部来自官方 API（用户已脱敏 p-xxx），不出校

## 运行
```bash
# 依赖 Node 20+（比赛服务器用项目内 runtime/，不污染系统环境）
node src/fetch_jobs.mjs 7        # 拉最近 7 天数据
node src/analyze.mjs 7           # 跑分析
node src/cli.mjs                 # 命令行对话
node src/server.mjs              # Web :8899
```
`.env` 配置 LLM（交我创 API）：
```
LLM_BASE_URL=https://models.sjtu.edu.cn/api/v1
LLM_API_KEY=sk-xxx
LLM_MODEL=qwen
```

## 实测结论（7 天数据）
- 14.4 万作业，排队过久 1.2 万个（最大浪费：排队等待 ~千万核时）
- 失败率 11%，反复失败 327 组
- 超时 1454 个；Top 超时作业申请 2h 实际跑 120h
- 局限：CPU 秒记账字段全为 0，利用率类规则自动降级为超时/长尾信号
