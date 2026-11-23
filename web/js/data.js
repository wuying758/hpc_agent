// 数据与连接管理
import { esc, api, relTime } from './utils.js';

export function initData() { loadStatus(); }

async function loadStatus() {
  const el = document.getElementById('dataBody');
  if (!el) return;
  try {
    const s = await api('/api/status');
    const fmtDay = d => d ? `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6)}` : '—';
    el.innerHTML = `
      <div class="status-card">
        <h4>HPC 集群连接</h4>
        <div class="status-row"><span class="label">配置状态</span><span class="val ${s.hpc.已配置 ? 'ok' : 'err'}">${s.hpc.已配置 ? '✓ 已配置' : '✗ 未配置'}</span></div>
        <div class="status-row"><span class="label">API 地址</span><span class="val" style="font-size:12px">${esc(s.hpc.地址 || '—')}</span></div>
        ${s.hpc.错误 ? `<div class="status-row"><span class="label">错误</span><span class="val err" style="font-size:11px">${esc(s.hpc.错误)}</span></div>` : ''}
      </div>
      <div class="status-card">
        <h4>模型连接</h4>
        <div class="status-row"><span class="label">配置状态</span><span class="val ${s.llm.已配置 ? 'ok' : 'err'}">${s.llm.已配置 ? '✓ 已配置' : '✗ 未配置'}</span></div>
        <div class="status-row"><span class="label">模型</span><span class="val">${esc(s.llm.模型 || '—')}</span></div>
      </div>
      <div class="status-card">
        <h4>数据状态</h4>
        <div class="status-row"><span class="label">数据文件</span><span class="val">${s.data.文件数} 个</span></div>
        <div class="status-row"><span class="label">覆盖范围</span><span class="val">${s.data.覆盖范围 ? fmtDay(s.data.覆盖范围.split(' ~ ')[0]) + ' ~ ' + fmtDay(s.data.覆盖范围.split(' ~ ')[1]) : '无'}</span></div>
        <div class="status-row"><span class="label">最近采集</span><span class="val">${s.data.最近采集 ? new Date(s.data.最近采集).toLocaleString('zh-CN') : '未记录'}</span></div>
        <div class="status-row"><span class="label">分析缓存更新</span><span class="val">${s.data.分析更新 ? new Date(s.data.分析更新).toLocaleString('zh-CN') : '未生成'}</span></div>
        <div class="status-row"><span class="label">服务运行</span><span class="val">${Math.round(s.uptime_s / 60)} 分钟</span></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-sm" id="checkConn">检查连接</button>
        <button class="btn btn-sm" id="fetchData">更新数据</button>
      </div>
      <div id="connResult" style="margin-top:12px"></div>
    `;
    document.getElementById('checkConn').onclick = doCheck;
    document.getElementById('fetchData').onclick = doFetch;
  } catch (e) {
    el.innerHTML = `<div class="empty">加载失败: ${esc(e.message)}</div>`;
  }
}

async function doCheck() {
  const el = document.getElementById('connResult');
  el.innerHTML = '<div style="font-size:12px;color:var(--dim)">检查中…</div>';
  try {
    const r = await api('/api/check-connection', { method: 'POST' });
    el.innerHTML = `
      <div style="font-size:12px;padding:8px 12px;border-radius:6px;background:${r.hpc.ok ? 'var(--ok-soft)' : 'var(--danger-soft)'}">
        <b>HPC:</b> ${r.hpc.ok ? '<span class="ok">✓ 连接成功</span>' : '<span class="err">✗ ' + esc(r.hpc.error || '失败') + '</span>'}
      </div>
      <div style="font-size:12px;padding:8px 12px;border-radius:6px;margin-top:6px;background:${r.llm.ok ? 'var(--ok-soft)' : 'var(--danger-soft)'}">
        <b>模型:</b> ${r.llm.ok ? `<span class="ok">✓ 连接成功 (${r.llm.status})</span>` : '<span class="err">✗ ' + esc(r.llm.error || '失败') + '</span>'}
      </div>`;
  } catch (e) {
    el.innerHTML = `<div style="font-size:12px;color:var(--danger)">检查失败: ${esc(e.message)}</div>`;
  }
}

async function doFetch() {
  const el = document.getElementById('connResult');
  try {
    const r = await api('/api/fetch-data', { method: 'POST' });
    el.innerHTML = `<div style="font-size:12px;padding:8px 12px;border-radius:6px;background:var(--acc-soft);color:var(--acc)">已触发数据更新，完成后刷新页面查看。</div>`;
  } catch (e) {
    el.innerHTML = `<div style="font-size:12px;color:var(--danger)">${esc(e.message)}</div>`;
  }
}
