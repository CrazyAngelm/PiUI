/**
 * Copy of the gate screen. The bundle never loads the desktop catalog for it:
 * this small table is the whole vocabulary of the screen before the shell mounts.
 */
import type { GateView } from './gateView';
import type { GateLanguage } from './launch';

interface Words {
  readonly connecting: string;
  readonly approvalTitle: string;
  readonly approvalDetail: string;
  readonly code: string;
  readonly refused: string;
  readonly timeout: string;
  readonly timeoutDetail: string;
  readonly busy: string;
  readonly busyDetail: string;
  readonly offline: string;
  readonly offlineDetail: string;
  readonly versions: string;
  readonly versionsDetail: string;
  readonly unsupported: string;
  readonly unsupportedDetail: string;
  readonly kicked: string;
  readonly disabled: string;
  readonly signedOut: string;
  readonly quit: string;
  readonly lost: string;
  readonly unauthorized: string;
  readonly unauthorizedDetail: string;
  readonly limited: string;
  readonly limitedDetail: string;
  readonly failed: string;
  readonly reconnect: string;
  readonly retryIn: string;
  readonly memoryKey: string;
}

const en: Words = {
  connecting: 'Connecting…',
  approvalTitle: 'Confirm on your computer',
  approvalDetail: 'Allow this browser on that computer. It must show the same code.',
  code: 'Code',
  refused: 'Connection refused',
  timeout: 'Not confirmed in time',
  timeoutDetail: 'Reconnect and confirm on your computer.',
  busy: 'The computer is busy',
  busyDetail: 'Another request is waiting there. Try again in a moment.',
  offline: 'Computer is offline',
  offlineDetail: 'Open Nano Desktop and turn on remote access.',
  versions: 'Versions differ',
  versionsDetail: 'Update Nano Desktop on your computer or reload this page.',
  unsupported: 'This browser cannot connect',
  unsupportedDetail: 'It cannot create the key remote access needs.',
  kicked: 'Disconnected on the computer',
  disabled: 'Access was turned off on the computer',
  signedOut: 'Nano Desktop signed out',
  quit: 'Nano Desktop was closed',
  lost: 'Connection lost',
  unauthorized: 'Your Nano session ended',
  unauthorizedDetail: 'Reload the page and sign in again.',
  limited: 'Too many connections',
  limitedDetail: 'Close other remote sessions and try again.',
  failed: 'Connection error',
  reconnect: 'Reconnect',
  retryIn: 'Reconnecting in {0} s…',
  memoryKey: 'This browser cannot keep its key, so every connection needs approval on the computer.',
};

const ru: Words = {
  connecting: 'Подключение…',
  approvalTitle: 'Подтвердите подключение на компьютере',
  approvalDetail: 'Разрешите этот браузер на том компьютере. Там должен быть тот же код.',
  code: 'Код',
  refused: 'Подключение отклонено',
  timeout: 'Не подтверждено вовремя',
  timeoutDetail: 'Переподключитесь и подтвердите на компьютере.',
  busy: 'Компьютер занят',
  busyDetail: 'Там уже ждёт другой запрос. Попробуйте чуть позже.',
  offline: 'Компьютер не в сети',
  offlineDetail: 'Откройте Nano Desktop и включите удалённый доступ.',
  versions: 'Версии не совпадают',
  versionsDetail: 'Обновите Nano Desktop на компьютере или перезагрузите страницу.',
  unsupported: 'Этот браузер не подходит',
  unsupportedDetail: 'Он не может создать ключ для удалённого доступа.',
  kicked: 'Отключено на компьютере',
  disabled: 'Доступ отключён на компьютере',
  signedOut: 'Nano Desktop вышел из аккаунта',
  quit: 'Nano Desktop закрыт',
  lost: 'Соединение потеряно',
  unauthorized: 'Сессия Nano завершена',
  unauthorizedDetail: 'Обновите страницу и войдите снова.',
  limited: 'Слишком много подключений',
  limitedDetail: 'Закройте другие удалённые сеансы и повторите.',
  failed: 'Ошибка соединения',
  reconnect: 'Переподключиться',
  retryIn: 'Переподключение через {0} с…',
  memoryKey: 'Этот браузер не сохраняет ключ, поэтому каждое подключение нужно подтверждать на компьютере.',
};

export const GATE_WORDS: Readonly<Record<GateLanguage, Words>> = { en, ru };

export interface GateText {
  readonly title: string;
  readonly detail: string | undefined;
  /** Whether the screen offers the Reconnect button. */
  readonly reconnect: boolean;
}

export function gateText(view: GateView, language: GateLanguage): GateText {
  const words = GATE_WORDS[language];
  switch (view.kind) {
    case 'connecting':
      return { title: words.connecting, detail: undefined, reconnect: false };
    case 'approval':
      return { title: words.approvalTitle, detail: words.approvalDetail, reconnect: false };
    case 'denied':
      if (view.reason === 'timeout') return { title: words.timeout, detail: words.timeoutDetail, reconnect: true };
      if (view.reason === 'busy') return { title: words.busy, detail: words.busyDetail, reconnect: true };
      return { title: words.refused, detail: undefined, reconnect: true };
    case 'offline':
      return { title: words.offline, detail: words.offlineDetail, reconnect: true };
    case 'versions':
      return { title: words.versions, detail: words.versionsDetail, reconnect: true };
    case 'unsupported':
      return { title: words.unsupported, detail: words.unsupportedDetail, reconnect: false };
    case 'disconnected':
      switch (view.reason) {
        case 'kicked':
          return { title: words.kicked, detail: undefined, reconnect: true };
        case 'disabled':
          return { title: words.disabled, detail: undefined, reconnect: true };
        case 'signed-out':
          return { title: words.signedOut, detail: undefined, reconnect: true };
        case 'quit':
          return { title: words.quit, detail: undefined, reconnect: true };
        case 'unauthorized':
          return { title: words.unauthorized, detail: words.unauthorizedDetail, reconnect: true };
        case 'limited':
          return { title: words.limited, detail: words.limitedDetail, reconnect: true };
        case 'protocol':
        case 'too-big':
          return { title: words.failed, detail: undefined, reconnect: true };
        case 'restart':
        case 'network':
        case 'idle':
        case 'replaced':
          return { title: words.lost, detail: undefined, reconnect: true };
        default: {
          const unreachable: never = view.reason;
          return unreachable;
        }
      }
    default: {
      const unreachable: never = view;
      return unreachable;
    }
  }
}

export function retryText(seconds: number, language: GateLanguage): string {
  return GATE_WORDS[language].retryIn.replace('{0}', String(seconds));
}

/** `908621` becomes `908 621`. */
export function groupCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** `908621` becomes `9 0 8 6 2 1`, so a screen reader reads digits, not a number. */
export function spokenCode(code: string): string {
  return Array.from(code).join(' ');
}
