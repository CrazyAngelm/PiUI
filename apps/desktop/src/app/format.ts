import type { Language } from '../features/locale/language';

const UNITS: Record<Language, { now: string; minute: string; hour: string; day: string }> = {
  en: { now: 'now', minute: 'm', hour: 'h', day: 'd' },
  ru: { now: 'сейчас', minute: ' мин', hour: ' ч', day: ' д' },
};

/** Compact relative time for dense lists: "now", "5m", "3h", "2d", then a date. */
export function relativeTime(iso: string | undefined, language: Language, now = Date.now()): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  const unit = UNITS[language];
  if (seconds < 60) return unit.now;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}${unit.minute}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}${unit.hour}`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}${unit.day}`;
  return new Date(time).toLocaleDateString(language === 'ru' ? 'ru-RU' : 'en-US', { month: 'short', day: 'numeric' });
}
