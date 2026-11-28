// 共享数据状态；关闭设置或离开此分组时停止轮询。
import { esc, api } from './utils.js';
import * as auth from './auth.js';

let timer, controller, version = 0, active = false, lastRun = null, lastStatus = null;
const $ = id => document.getElementById(id);
const dateTime = t => t ? new Date(t).toLocaleString('zh-CN') : '尚未记录';

export function stopDataRefresh() {
  active = false;
  version++;
  clearTimeout(timer);
  controller?.abort();
}
export function initData() { refreshDataGroup(); }
export async function refreshDataGroup() {
  stopDataRefresh();
  active = true;
  controller = new AbortController();
  const current = version;
  const el = $('dataBody');
  if (!auth.isLogged()) {
    el.innerHTML = '<div class="settings-empty"><strong>登录后查看共享数据</strong><p>同步将使用发起人的 HPC 登录凭据。</p><button type="button" class="btn btn-primary" data-settings-login>登录 HPC 账号</button></div>';
    return;
  }
  el.innerHTML = '<div class="settings-feedback" role="status">正在读取集群数据状态…</div>';
  try {
    const [status, sync] = await Promise.all([
      api('/api/status', { signal: controller.signal }),
      api('/api/sync-status', { signal: controller.signal }),
    ]);
    if (!active || current !== version) return;
    el.innerHTML = `<div class="data-section"><div class="settings-card-head"><h5>数据快照</h5><span class="subtle-tag">全站共享</span></div><div id="dataSnapshot" class="settings-detail-list"></div></div>
      <div class="data-section"><div class="settings-card-head"><h5>共享同步</h5><button type="button" class="btn btn-primary btn-sm" id="fetchData">更新数据</button></div><div id="syncCard" aria-live="polite"></div></div>
      <div class="settings-note"><strong>一份集群数据，一次同步任务</strong><p>多人同时更新时会查看同一个任务的进度。同步完成后，集群总览与作业列表自动刷新。</p></div>
      <div id="connResult" class="settings-feedback" role="status" hidden></div>`;
    renderSnapshot(status);
    renderSync(sync);
    $('fetchData').onclick = doFetch;
    observeSync(sync, current);
  } catch (e) {
    if (!active || current !== version) return;
    el.innerHTML = `<div class="settings-feedback" data-kind="error">${esc(e.message)} <button type="button" class="text-button" id="dataRetry">重新读取</button></div>`;
    $('dataRetry').onclick = refreshDataGroup;
  }
}
function renderSnapshot(s) {
  const range = s.data.覆盖范围?.split(' ~ ');
  const day = value => /^\d{8}$/.test(value || '') ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : '—';
  $('dataSnapshot').innerHTML = [
    ['覆盖范围', range?.length === 2 ? `${day(range[0])} — ${day(range[1])}` : '尚无数据'],
    ['数据文件', `${s.data.文件数} 个`],
    ['最近采集', dateTime(s.data.最近采集)],
    ['分析快照生成', dateTime(s.data.分析更新)],
  ].map(([label, value]) => `<div><span>${label}</span><strong>${esc(value)}</strong></div>`).join('');
}
function renderSync(s) {
  const running = s.status === 'running';
  const labels = { idle: '○ 等待更新', running: '◌ 同步进行中', done: '✓ 上次同步完成', error: '× 上次同步失败' };
  const progress = Math.max(0, Math.min(100, Number(s.progress) || 0));
  $('syncCard').innerHTML = `<div class="sync-summary"><span class="connection-badge ${s.status === 'done' ? 'is-ready' : s.status === 'error' ? 'is-error' : ''}">${labels[s.status] || '正在读取'}</span>${running ? `<span>${progress}%</span>` : ''}</div>
    ${running ? `<progress class="sync-progress" value="${progress}" max="100" aria-label="共享数据同步进度">${progress}%</progress>` : ''}
    <p class="sync-description">${esc(s.error || s.message || '需要最新数据时，点击更新。')}</p>
    ${s.startedAt ? `<div class="sync-meta"><span>由 ${esc(s.by || '已登录用户')} 发起</span><span>${esc(dateTime(s.startedAt))}</span>${s.durationS != null ? `<span>用时 ${esc(String(s.durationS))} 秒</span>` : ''}</div>` : ''}`;
  const btn = $('fetchData');
  btn.disabled = running;
  btn.textContent = running ? '同步进行中…' : s.status === 'error' ? '重新同步' : '更新数据';
}
function observeSync(s, current) {
  if (s.status === 'done' && (lastStatus === 'running' || (lastRun && lastRun !== s.startedAt))) {
    window.dispatchEvent(new CustomEvent('cluster-data-updated'));
  }
  const completed = lastStatus === 'running' && s.status !== 'running';
  lastRun = s.startedAt;
  lastStatus = s.status;
  if (completed) {
    api('/api/status', { signal: controller.signal }).then(status => {
      if (active && current === version) renderSnapshot(status);
    }).catch(() => {});
  }
  if (s.status === 'running') schedulePoll(current);
}
function schedulePoll(current) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (!active || current !== version) return;
    try {
      const s = await api('/api/sync-status', { signal: controller.signal });
      if (!active || current !== version) return;
      $('connResult').hidden = true;
      renderSync(s);
      observeSync(s, current);
    } catch (e) {
      if (!active || current !== version) return;
      $('connResult').textContent = '进度读取失败，正在重试…';
      $('connResult').hidden = false;
      schedulePoll(current);
    }
  }, 1600);
}
async function doFetch() {
  const current = version, btn = $('fetchData');
  btn.disabled = true;
  btn.textContent = '正在发起…';
  $('connResult').hidden = true;
  try {
    await api('/api/fetch-data', { method: 'POST', signal: controller.signal });
    if (!active || current !== version) return;
    lastStatus = 'running';
    const s = await api('/api/sync-status', { signal: controller.signal });
    if (!active || current !== version) return;
    renderSync(s);
    observeSync(s, current);
  } catch (e) {
    if (!active || current !== version) return;
    $('connResult').textContent = e.message;
    $('connResult').dataset.kind = 'error';
    $('connResult').hidden = false;
    btn.disabled = false;
    btn.textContent = '重试更新';
  }
}
