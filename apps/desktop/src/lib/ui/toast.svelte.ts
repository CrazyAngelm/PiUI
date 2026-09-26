/**
 * Minimal toast queue. Toasts are for transient confirmations and recoverable
 * failures; blocking decisions belong in dialogs or the Inbox.
 */
export type ToastTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
  action?: ToastAction;
  /** Milliseconds; 0 keeps the toast until dismissed. */
  duration: number;
}

class ToastQueue {
  items = $state<Toast[]>([]);
  private next = 1;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  show(input: Omit<Toast, 'id' | 'duration' | 'tone'> & { tone?: ToastTone; duration?: number }): number {
    const id = this.next++;
    const tone = input.tone ?? 'neutral';
    const duration = input.duration ?? (tone === 'danger' ? 0 : 4500);
    this.items = [...this.items.slice(-3), { ...input, id, tone, duration }];
    if (duration > 0) this.timers.set(id, setTimeout(() => this.dismiss(id), duration));
    return id;
  }

  success(title: string, description?: string): number {
    return this.show({ tone: 'success', title, description });
  }

  error(title: string, description?: string, action?: ToastAction): number {
    return this.show({ tone: 'danger', title, description, action });
  }

  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
    this.items = this.items.filter((toast) => toast.id !== id);
  }
}

export const toasts = new ToastQueue();
