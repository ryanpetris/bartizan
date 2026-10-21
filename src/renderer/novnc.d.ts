declare module '@novnc/novnc' {
  export type Credentials = { username?: string; password?: string; target?: string };
  type Events = {
    connect: object;
    disconnect: { clean: boolean };
    credentialsrequired: { types: (keyof Credentials)[] };
    securityfailure: { status: number; reason?: string };
    serververification: { type: string; publickey: Uint8Array };
    clipboard: { text: string };
  };
  /** The parts of noVNC's viewer that Bartizan uses. A channel is any object with a WebSocket's members. */
  export default class RFB {
    constructor(target: HTMLElement, channel: object, options?: { credentials?: Credentials });
    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    showDotCursor: boolean;
    qualityLevel: number;
    compressionLevel: number;
    background: string;
    addEventListener<K extends keyof Events>(type: K, listener: (event: CustomEvent<Events[K]>) => void): void;
    disconnect(): void;
    approveServer(): void;
    sendCredentials(credentials: Credentials): void;
    focus(options?: FocusOptions): void;
    sendCtrlAltDel(): void;
    /** Presses and releases a key, or with `down` only presses or releases it. */
    sendKey(keysym: number, code: string, down?: boolean): void;
    clipboardPasteFrom(text: string): void;
  }
}
