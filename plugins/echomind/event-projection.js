// 对话事件与尾部交互卡片投影常量与纯函数（index.js 与 client.js 共享协议）。

export const AUTH_REQUIRED_KIND = 'echomind-auth-required';
export const RECORDING_CARD_KIND = 'echomind-recording-card';
export const MINUTES_CARD_KIND = 'echomind-minutes-card';
export const TODO_DRAFT_KIND = 'echomind-todo-draft';

export const RECORDING_EVENT_RECORD_TYPE = 'plugin:echomind/recording-event';
export const MINUTES_PRESENTED_RECORD_TYPE = 'plugin:echomind/minutes-presented';
export const TODO_DRAFT_RECORD_TYPE = 'plugin:echomind/todo-draft';
export const TODO_PUSHED_RECORD_TYPE = 'plugin:echomind/todos-pushed';

export const ALL_RECORD_TYPES = Object.freeze([
  RECORDING_EVENT_RECORD_TYPE,
  MINUTES_PRESENTED_RECORD_TYPE,
  TODO_DRAFT_RECORD_TYPE,
  TODO_PUSHED_RECORD_TYPE,
]);

export function parseToolPayload(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}
