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



## Web 个人连接设置

登录后打开左下角「设置」：
- **账号与集群**：查看当前 HPC 身份、重新登录或退出。
- **模型 API**：填写 OpenAI 兼容 Base URL、自己的 API Key 和默认模型 ID。可以先获取模型列表，也可以手动输入模型 ID 后直接保存。密钥不回显，编辑已有连接时留空保留原密钥；更换服务地址需要重填。
- **数据与同步**：所有登录用户共用集群全部作业和同一个同步任务。页面展示共享进度，同步完成后更新总览。
- **外观**：即时切换浅色、深色主题。

Web 对话、标题、后续建议和后台分析任务使用请求开始时的个人模型配置快照。未配置时会引导设置，不使用部署者的 API Key。输入框旁「我的默认模型」使用个人保存的默认值；其他选项只影响临时模型选择。

部署方通过 `LLM_BASE_URL` 指定默认允许的网关，或用 `LLM_ALLOWED_HOSTS` 添加允许的模型服务（逗号分隔；带端口或 HTTP 的校内网关请填写完整 origin，例如 `https://gateway.example.edu:8443`）。服务地址不得包含密码、查询参数或片段；带认证的上游请求不会跟随重定向。

`LLM_ENCRYPTION_KEY` 用于加密个人 API Key，建议部署时设置 32 字节随机密钥（64 位 hex）并安全备份。未设置时服务首次保存配置会生成并持久化至 `.env`，写入失败会明确报错。更换或丢失主密钥后，需要用户重新填写个人 API Key。CLI 继续使用部署侧 `LLM_BASE_URL`、`LLM_API_KEY` 和 `LLM_MODEL`。
