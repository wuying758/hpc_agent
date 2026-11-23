// 前端状态管理
export const state = {
  page: 'chat',
  sessionId: null,
  busy: false,
  days: 7,
  // jobs
  jState: '', jPartition: '', jDays: 7, jSearch: '', jPage: 1,
  // tickets
  tStatus: '', tSearch: '',
};

export function navigate(page) {
  state.page = page;
  window.location.hash = '#/' + page;
}
