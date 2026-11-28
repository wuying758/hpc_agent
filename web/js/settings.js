// 个人设置：界面状态、模型草稿、账号与主题。
import { api, esc } from './utils.js';
import * as auth from './auth.js';
import { refreshDataGroup, stopDataRefresh } from './data.js';

const $ = id => document.getElementById(id);
let group = 'account', saved = null, loading = null, checking = null;
let generation = 0, saving = false, returnFocus;

function feedback(id, text = '', kind = '') {
  const el = $(id);
  el.textContent = text;
  el.dataset.kind = kind;
  el.hidden = !text;
}
function draft() {
  return { baseUrl: $('modelBaseUrl').value.trim().replace(/\/+$/, ''), apiKey: $('modelApiKey').value.trim(), model: $('modelDefault').value.trim() };
}
function dirty() {
  if (!saved) return false;
  const d = draft();
  return !!d.apiKey || d.baseUrl !== (saved.baseUrl || '').replace(/\/+$/, '') || d.model !== (saved.model || '');
}
function updateDraft() {
  checking?.abort();
  checking = null;
  $('modelCheck').disabled = false;
  $('modelCheck').textContent = '获取模型列表';
  $('modelChoices').replaceChildren();
  feedback('modelFeedback');
  const changed = dirty();
  $('modelSaveHint').textContent = changed ? '有尚未保存的修改' : '配置仅对你生效';
  $('modelReset').disabled = !changed;
  $('modelSave').disabled = !changed && !!saved?.configured;
  const changedBase = saved?.configured && draft().baseUrl !== saved.baseUrl.replace(/\/+$/, '');
  $('modelApiKey').required = !saved?.hasApiKey || changedBase;
  $('modelApiKey').placeholder = saved?.hasApiKey && !changedBase ? '已保存 · 留空保留原密钥' : '输入你的 API Key';
  $('modelKeyHint').textContent = changedBase ? '服务地址已改变，请为新服务填写 API Key。' : '密钥加密保存在服务端，不会回显到页面。';
}
function fillForm() {
  $('modelBaseUrl').value = saved?.baseUrl || '';
  $('modelDefault').value = saved?.model || '';
  clearKey();
  $('modelKeyState').textContent = saved?.hasApiKey ? '已安全保存' : '尚未保存密钥';
  const configured = saved?.configured && saved?.hasApiKey;
  $('modelConfigBadge').textContent = configured ? '✓ 已配置个人连接' : '○ 尚未配置';
  $('modelConfigBadge').classList.toggle('is-ready', !!configured);
  $('modelConfigMeta').textContent = configured ? `版本 ${saved.version} · 仅对当前账号生效` : '填写后即可开始智能分析';
  updateDraft();
}
function clearKey() {
  $('modelApiKey').value = '';
  $('modelApiKey').type = 'password';
  $('modelKeyToggle').textContent = '显示';
  $('modelKeyToggle').setAttribute('aria-label', '显示 API Key');
  $('modelKeyToggle').setAttribute('aria-pressed', 'false');
}
function lockForm(locked) {
  $('modelConfigForm').querySelectorAll('input, button').forEach(el => { el.disabled = locked; });
  $('modelSave').textContent = locked ? '保存中…' : '保存配置';
}
async function loadModel() {
  if (!auth.isLogged()) {
    $('modelLoginGate').hidden = false;
    $('modelConfigForm').hidden = true;
    feedback('modelLoadState');
    return;
  }
  $('modelLoginGate').hidden = true;
  if (saved) { $('modelConfigForm').hidden = false; return; }
  loading?.abort();
  const ctrl = loading = new AbortController(), version = generation;
  $('modelConfigForm').hidden = true;
  feedback('modelLoadState', '正在读取你的模型配置…');
  try {
    const config = await api('/api/llm-config', { signal: ctrl.signal });
    if (version !== generation || ctrl.signal.aborted) return;
    saved = config;
    fillForm();
    $('modelConfigForm').hidden = false;
    $('modelConfigDot').hidden = !!(config.configured && config.hasApiKey);
    feedback('modelLoadState');
  } catch (e) {
    if (version !== generation || ctrl.signal.aborted) return;
    feedback('modelLoadState', e.message, 'error');
    const retry = document.createElement('button');
    retry.type = 'button'; retry.className = 'text-button'; retry.textContent = '重新读取'; retry.onclick = loadModel;
    $('modelLoadState').append(' ', retry);
  }
}
async function checkModel() {
  const base = $('modelBaseUrl'), key = $('modelApiKey');
  if (!base.reportValidity() || !key.reportValidity()) return;
  if (!base.value.trim()) return;
  checking?.abort();
  const ctrl = checking = new AbortController(), version = generation;
  $('modelCheck').disabled = true;
  $('modelCheck').textContent = '获取中…';
  feedback('modelFeedback', '正在获取模型列表…');
  try {
    const result = await api('/api/llm-config/check', { method: 'POST', body: draft(), signal: ctrl.signal });
    if (version !== generation || ctrl.signal.aborted) return;
    if (result.state === 'ok') {
      $('modelChoices').replaceChildren(...result.models.map(id => new Option(id, id)));
      feedback('modelFeedback', `已获取 ${result.models.length} 个模型。可在默认模型输入框选择，也可以手动填写。`, 'success');
      $('modelDefault').focus();
    } else feedback('modelFeedback', result.error || result.note, result.state === 'error' ? 'error' : 'notice');
  } catch (e) {
    if (version === generation && !ctrl.signal.aborted) feedback('modelFeedback', e.message, 'error');
  } finally {
    if (checking === ctrl) {
      checking = null;
      $('modelCheck').disabled = false;
      $('modelCheck').textContent = '获取模型列表';
    }
  }
}
async function saveModel(e) {
  e.preventDefault();
  if (saving) return;
  checking?.abort(); checking = null;
  const version = generation, owner = auth.getAuth().username, body = draft();
  saving = true;
  lockForm(true);
  feedback('modelFeedback');
  try {
    const result = await api('/api/llm-config', { method: 'POST', body });
    if (version !== generation) return;
    saved = result;
    lockForm(false);
    fillForm();
    $('modelConfigDot').hidden = true;
    feedback('modelFeedback', '已保存。下一次对话和新建分析任务将使用此配置。', 'success');
    window.dispatchEvent(new CustomEvent('model-config-changed', { detail: { owner } }));
  } catch (err) {
    if (version !== generation) return;
    lockForm(false);
    updateDraft();
    feedback('modelFeedback', err.message, 'error');
  } finally {
    if (version === generation) saving = false;
  }
}
function renderAccount() {
  const s = auth.getAuth();
  $('settingsUserName').textContent = s.username || '尚未登录';
  $('settingsUserMark').textContent = s.username?.[0]?.toUpperCase() || 'H';
  $('accountInfo').innerHTML = s.logged_in
    ? `<div class="account-profile"><span class="account-avatar">${esc(s.username[0]?.toUpperCase())}</span><div><strong>${esc(s.username)}</strong><span>JAccount · HPC 集群账号</span></div><span class="connection-badge is-ready">✓ 已登录</span></div>
       <div class="settings-detail-list"><div><span>登录有效期</span><strong>${s.expires ? esc(new Date(s.expires).toLocaleString('zh-CN')) : '—'}</strong></div><div><span>集群数据范围</span><strong>全部作业 · 全站共享</strong></div></div>
       <div class="account-actions"><button type="button" class="btn" data-settings-login>重新登录</button><button type="button" class="btn btn-quiet-danger" id="accountLogout">退出当前账号</button></div>`
    : '<div class="settings-empty"><strong>连接你的工作空间</strong><p>登录后可浏览集群、保存分析记录，并配置个人模型。</p><button type="button" class="btn btn-primary" data-settings-login>登录 HPC 账号</button></div>';
  $('accountLogout')?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await auth.logout(); }
    catch (err) { feedback('accountFeedback', err.message, 'error'); btn.disabled = false; }
  });
}
function showGroup(next) {
  group = ['account', 'model', 'data', 'appearance'].includes(next) ? next : 'account';
  stopDataRefresh();
  document.querySelectorAll('#settingsNav [data-group]').forEach(el => {
    el.classList.toggle('active', el.dataset.group === group);
    if (el.dataset.group === group) el.setAttribute('aria-current', 'true');
    else el.removeAttribute('aria-current');
  });
  document.querySelectorAll('.settings-group').forEach(el => { el.hidden = el.dataset.group !== group; });
  document.querySelector('.settings-content').scrollTop = 0;
  if (group === 'model') loadModel();
  if (group === 'data') refreshDataGroup();
}
function backgroundInert(on) {
  ['nav', 'main', 'navToggle', 'navBackdrop', 'drawer'].forEach(id => { $(id).inert = on; });
}
export function openSettings(next = group) {
  window.dispatchEvent(new Event('settings-opened'));
  if ($('settingsPanel').hidden) returnFocus = document.activeElement;
  $('settingsPanel').hidden = $('settingsBackdrop').hidden = false;
  $('settingsPanel').classList.add('open');
  $('settingsBackdrop').classList.add('open');
  $('settingsBtn').setAttribute('aria-expanded', 'true');
  backgroundInert(true);
  showGroup(next);
  $('settingsClose').focus({ preventScroll: true });
}
export function closeSettings() {
  if (saving) return;
  if (dirty() && !window.confirm('模型配置尚未保存，要放弃修改并关闭吗？')) return;
  generation++;
  loading?.abort(); checking?.abort();
  loading = checking = null; saved = null;
  clearKey();
  stopDataRefresh();
  $('settingsPanel').classList.remove('open');
  $('settingsBackdrop').classList.remove('open');
  $('settingsBtn').setAttribute('aria-expanded', 'false');
  backgroundInert(false);
  const mobileNavTrigger = window.matchMedia('(max-width: 768px)').matches && returnFocus?.closest('#nav');
  (mobileNavTrigger ? $('navToggle') : returnFocus?.isConnected ? returnFocus : $('settingsBtn')).focus();
  $('settingsPanel').hidden = $('settingsBackdrop').hidden = true;
}
export function initSettings() {
  window.openSettings = openSettings;
  $('settingsBtn').onclick = () => openSettings();
  $('settingsClose').onclick = closeSettings;
  $('settingsBackdrop').onclick = closeSettings;
  $('settingsPanel').onclick = e => {
    if (e.target.closest('[data-settings-login]')) window.openLogin?.();
  };
  document.querySelectorAll('#settingsNav [data-group]').forEach(el => { el.onclick = () => { if (el.dataset.group !== group) showGroup(el.dataset.group); }; });
  const applyTheme = theme => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('theme', theme); } catch {}
    document.querySelectorAll('.theme-option').forEach(el => {
      el.classList.toggle('active', el.dataset.theme === theme);
      el.setAttribute('aria-pressed', String(el.dataset.theme === theme));
    });
  };
  applyTheme(document.documentElement.dataset.theme || 'light');
  document.querySelectorAll('.theme-option').forEach(el => { el.onclick = () => applyTheme(el.dataset.theme); });
  ['modelBaseUrl', 'modelApiKey', 'modelDefault'].forEach(id => { $(id).oninput = updateDraft; });
  $('modelReset').onclick = fillForm;
  $('modelKeyToggle').onclick = () => {
    const reveal = $('modelApiKey').type === 'password';
    $('modelApiKey').type = reveal ? 'text' : 'password';
    $('modelKeyToggle').textContent = reveal ? '隐藏' : '显示';
    $('modelKeyToggle').setAttribute('aria-pressed', String(reveal));
    $('modelKeyToggle').setAttribute('aria-label', reveal ? '隐藏 API Key' : '显示 API Key');
  };
  $('modelCheck').onclick = checkModel;
  $('modelConfigForm').onsubmit = saveModel;
  document.addEventListener('keydown', e => {
    if (!$('settingsPanel').classList.contains('open') || !$('loginModal').hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeSettings(); }
    if (e.key === 'Tab') {
      const items = [...$('settingsPanel').querySelectorAll('button, input, a[href]')].filter(el => !el.disabled && el.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  auth.onAuthChange(renderAccount);
  auth.onAccountChange(() => {
    generation++;
    loading?.abort(); checking?.abort();
    saved = loading = checking = null; saving = false;
    lockForm(false); clearKey();
    $('modelBaseUrl').value = $('modelDefault').value = '';
    $('modelChoices').replaceChildren();
    $('modelConfigForm').hidden = true;
    $('modelConfigDot').hidden = true;
    feedback('modelFeedback'); feedback('accountFeedback'); feedback('modelLoadState');
    stopDataRefresh();
    $('dataBody').replaceChildren();
    if ($('settingsPanel').classList.contains('open')) showGroup(group);
  });
  renderAccount();
}
