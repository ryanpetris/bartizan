import type { HelperEnvelope, HelperMessage } from './helper-messages';
import type { API, Event } from './shared';
import type { Transport } from './transport';
export function createClient(transport: Transport): API {
  let nextId = 0;
  const call = async (method: string, ...args: unknown[]): Promise<any> => {
    while (args.length && args.at(-1) === undefined) args.pop();
    const response = await transport.request({ id: ++nextId, method, args });
    if (response.error !== undefined) throw new Error(response.error);
    return response.result;
  };
  const notify = (method: string, ...args: unknown[]) => {
    void call(method, ...args).catch(error => console.error(`${method}:`, error));
  };
return {
  capabilities: () => call('capabilities'),
  graphics: event => notify('graphics', event),
  reportError: input => call('report-error', input),
  clearErrors: () => call('clear-errors'),
  answerCertificate: (id, allow) => call('certificate-answer', id, allow),
  profileDraft: id => call('profile-draft', id),
  profilePreview: input => call('profile-preview', input),
  profileConnect: input => call('profile-connect', input),
  profileSave: input => call('profile-save', input),
  reloadConfig: () => call('reload-config'),
  chooseFile: () => call('choose-file'),
  activatedWithin: milliseconds => call('activated-within', milliseconds),
  askingToQuit: () => notify('asking-to-quit'),
  quit: () => notify('quit'),
  answerQuestion: (id, proceed) => notify('answer-question', id, proceed),
  setFullscreen: mode => call('set-fullscreen', mode),
  settings: patch => call('settings', patch),
  details: id => call('details', id),
  connect: target => call('connect', target),
  disconnect: id => call('disconnect', id),
  removeConnection: id => call('remove-connection', id),
  reconnect: id => call('reconnect', id),
  sendHelperMessage: (id, message) => call('helper-message', id, message),
  onHelperMessage: (type, callback) => transport.onEvent(event => {
    if (event.type === 'helper' && event.message.type === type) {
      try { callback(structuredClone(event) as unknown as HelperEnvelope<Extract<HelperMessage, { type: typeof type }>>); }
      catch (error) { console.error(error); }
    }
  }),
  resumeRemoteSessions: (id, keys, takeover) => call('resume-remote-sessions', id, keys, takeover),
  killRemoteSession: (id, key) => call('kill-remote-session', id, key),
  newTerminal: id => call('new-terminal', id),
  reconnectTerminal: id => call('reconnect-terminal', id),
  closeTerminal: id => call('close-terminal', id),
  newApplication: (id, application) => call('new-application', id, application),
  retryApplication: id => call('retry-application', id),
  respondApplication: (id, consentId, accepted) => call('respond-application', id, consentId, accepted),
  newBrowser: id => call('new-browser', id),
  newBrowserTab: (id, session) => call('new-browser-tab', id, session),
  remotePorts: id => call('remote-ports', id),
  renameBrowser: (id, name) => call('rename-browser', id, name),
  openLink: (id, url, session) => call('open-link', id, url, session),
  linkMenu: (id, url, at, session) => call('link-menu', id, url, at, session),
  copy: text => call('copy', text),
  readClipboard: () => call('read-clipboard'),
  menuChosen: (id, item) => notify('menu-chosen', id, item),
  input: (id, data) => notify('input', id, data),
  resize: (id, cols, rows, repaint) => notify('resize', id, cols, rows, repaint),
  acknowledge: (id, size) => notify('acknowledge', id, size),
  answer: (id, value) => call('answer', id, value),
  browser: (id, action, tab, url) => call('browser', id, action, tab, url),
  find: (id, tab, request) => call('find', id, tab, request),
  download: (id, action, download) => call('download', id, action, download),
  showBrowser: (id, bounds, tools) => notify('show-browser', id, bounds, tools),
  overlay: (name, bounds) => notify('overlay', name, bounds),
  onEvent: transport.onEvent,
};
}
