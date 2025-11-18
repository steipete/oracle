declare module 'toasted-notifier' {
  export interface ToastOptions {
    title?: string;
    subtitle?: string;
    message: string;
    sound?: boolean | string;
    icon?: string;
    wait?: boolean;
    appID?: string;
    timeout?: number;
    closeLabel?: string;
    actions?: string[];
    reply?: boolean;
    open?: string;
    id?: string;
    suppressOSD?: boolean;
  }

  const notifier: {
    notify(options: ToastOptions): Promise<void> | void;
  };

  export default notifier;
}
