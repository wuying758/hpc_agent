// 数据与连接管理（渲染进设置面板的「数据与连接」分组）
import { esc, api } from './utils.js';

// 进入数据分组时刷新；每次打开都会调用
export function refreshDataGroup() { loadStatus(); }

// 兼容旧入口
export function initData() { loadStatus(); }

async function loadStatus() {
  const el = document.getElementById('dataBody');
  if (!el) return;
  el.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const s = await api('/api/status');
    const fmtDay = d => d ? `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6)}` : '—';
    const range = s.data.覆盖范围 ? s.data.覆盖范围.split(' ~ ') : null;
    el.innerHTML = `
      <h4>数据与连接</h4>
      <p class="settings-group-desc">HPC 集群与模型 API 的连接状态、数据覆盖范围</p>
      <div class="status-card">
        <h5>HPC 集群连接</h5>
        <div class="status-row"><span class="label">配置状态</span><span class="val ${s.hpc.已配置 ? 'ok' : 'err'}">${s.hpc.已配置 ? '✓ 已配置' : '✗ 未配置'}</span></div>
        <div class="status-row"><span class="label">API 地址</span><span class="val" style="font-size:12px">${esc(s.hpc.地址 || '—')}</span></div>
        ${s.hpc.错误 ? `<div class="status-row"><span class="label">错误</span><span class="val err" style="font-size:11px">${esc(s.hpc.错误)}</span></div>` : ''}
      </div>
      <div class="status-card">
        <h5>模型连接</h5>
        <div class="status-row"><span class="label">配置状态</span><span class="val ${s.llm.已配置 ? 'ok' : 'err'}">${s.llm.已配置 ? '✓ 已配置' : '✗ 未配置'}</span></div>
        <div class="status-row"><span class="label">模型</span><span class="val">${esc(s.llm.模型 || '—')}</span></div>
      </div>
      <div class="status-card">
        <h5>数据状态</h5>
        <div class="status-row"><span class="label">数据文件</span><span class="val">${s.data.文件数} 个</span></div>
        <div class="status-row"><span class="label">覆盖范围</span><span class="val">${range ? fmtDay(range[0]) + ' ~ ' + fmtDay(range[1]) : '无'}</span></div>
        <div class="status-row"><span class="label">最近采集</span><span class="val">${s.data.最近采集 ? new Date(s.data.最近采集).toLocaleString('zh-CN') : '未记录'}</span></div>
        <div class="status-row"><span class="label">分析缓存更新</span><span class="val">${s.data.分析更新 ? new Date(s.data.分析更新).toLocaleString('zh-CN') : '未生成'}</span></div>
        <div class="status-row"><span class="label">服务运行</span><span class="val">${Math.round(s.uptime_s / 60)} 分钟</span></div>
      </div>
      <div class="status-card">
        <h5>共享数据同步</h5>
        <div id="syncCard" class="sync-card"></div>
      </div>
      <div class="settings-actions">
        <button class="btn btn-sm" id="checkConn">检查连接</button>
        <button class="btn btn-sm btn-primary" id="fetchData">更新数据</button>
      </div>
      <div id="connResult" class="conn-result"></div>
    `;
    document.getElementById('checkConn').onclick = doCheck;
    document.getElementById('fetchData').onclick = doFetch;
    renderSyncCard(null, { status: 'loading' });
    loadSyncStatus();
  } catch (e) {
    el.innerHTML = `<div class="empty">加载失败: ${esc(e.message)}</div>`;
  }
}

async function doCheck() {
  const el = document.getElementById('connResult');
  el.innerHTML = '<div class="conn-line">检查中…</div>';
  try {
    const r = await api('/api/check-connection', { method: 'POST' });
    const hpcMsg = r.hpc.ok ? '✓ 连接成功'
      : (r.hpc.needReauth ? '⚠ ' + esc(r.hpc.error || '登录已过期，请重新登录')
      : '✗ ' + esc(r.hpc.error || '失败'));
    el.innerHTML = `
      <div class="conn-line ${r.hpc.ok ? 'ok' : 'err'}"><b>HPC:</b> ${hpcMsg}</div>
      <div class="conn-line ${r.llm.ok ? 'ok' : 'err'}"><b>模型:</b> ${r.llm.ok ? `✓ 连接成功 (${r.llm.status})` : '✗ ' + esc(r.llm.error || '失败')}</div>`;
  } catch (e) {
    el.innerHTML = `<div class="conn-line err">检查失败: ${esc(e.message)}</div>`;
  }
}

async function doFetch() {
  const el = document.getElementById('connResult');
  const btn = document.getElementById('fetchData');
  btn.disabled = true;
  renderSyncCard(null, { status: 'starting', message: '正在发起同步…' });
  try {
    const r = await api('/api/fetch-data', { method: 'POST' });
    if (r.alreadyRunning) {
      el.innerHTML = `<div class="conn-line">已有同步在进行中，正在查看共享进度…</div>`;
    } else {
      el.innerHTML = `<div class="conn-line ok">已启动共享数据同步（大家共用同一任务）。</div>`;
    }
    // 轮询进度直到结束
    pollSync();
  } catch (e) {
    el.innerHTML = `<div class="conn-line err">${esc(e.message)}</div>`;
    btn.disabled = false;
    renderSyncCard(null, { status: 'error', message: e.message });
  }
}

let pollTimer = null;
async function pollSync() {
  stopPoll();
  pollTimer = setInterval(async () => {
    try {
      const s = await api('/api/sync-status');
      renderSyncCard(null, s);
      if (s.status !== 'running') {
        stopPoll();
        const btn = document.getElementById('fetchData');
        if (btn) btn.disabled = false;
        // 同步完成后刷新数据状态（文件数/覆盖范围会变化）
        loadStatus();
      }
    } catch (e) { /* 忽略单次轮询失败 */ }
  }, 1500);
}
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function loadSyncStatus() {
  try {
    const s = await api('/api/sync-status');
    renderSyncCard(null, s);
    if (s.status === 'running') pollSync(); // 面板打开时若正在同步，继续轮询
  } catch { renderSyncCard(null, { status: 'idle' }); }
}

function renderSyncCard(_root, s) {
  const el = document.getElementById('syncCard');
  if (!el) return;
  const label = { idle: '空闲', running: '同步中…', done: '已完成', error: '同步失败' }[s.status] || s.status;
  const cls = { idle: '', running: 'running', done: 'ok', error: 'err' }[s.status] || '';
  let bar = '';
  if (s.status === 'running') {
    bar = `<div class="sync-bar"><div class="sync-bar-fill" style="width:${s.progress || 0}%"></div></div>
      <div class="status-row"><span class="label">进度</span><span class="val">${s.progress || 0}%${s.total ? ' · 已拉 ' + s.total + ' 条' : ''}</span></div>`;
  }
  const when = (t) => t ? new Date(t).toLocaleTimeString('zh-CN') : '';
  let extra = '';
  if (s.status === 'done') extra = `<div class="status-row"><span class="label">结果</span><span class="val">${esc(s.message || '')}</span></div>
    ${s.durationS != null ? `<div class="status-row"><span class="label">用时</span><span class="val">${s.durationS}s</span></div>` : ''}`;
  if (s.status === 'error') extra = `<div class="status-row"><span class="label">错误</span><span class="val err" style="font-size:12px">${esc(s.error || s.message || '')}</span></div>`;
  el.innerHTML = `
    <div class="status-row"><span class="label">状态</span><span class="val ${cls}">${label}</span></div>
    ${bar}
    ${extra}
    ${s.by ? `<div class="status-row"><span class="label">发起人</span><span class="val" style="font-size:12px">${esc(s.by)}</span></div>` : ''}
    ${s.startedAt ? `<div class="status-row"><span class="label">开始</span><span class="val" style="font-size:12px">${when(s.startedAt)}</span></div>` : ''}
    <p class="settings-group-desc" style="margin-top:8px">共享集群数据：同一时间只跑一个同步任务，多人可看到同一进度。</p>`;
}
