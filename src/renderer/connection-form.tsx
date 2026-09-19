import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Spec } from '../core/config';
import type { ProfileDraft, ProfileChanges } from '../shared';
import { Icon, IconButton, Button, moveFocus } from './ui';
import { api, store, render, describeError, report, profileName, activeConnection, focusConnection } from './store';
import { openModal } from './dialogs';
import { FontPicker, bundledTerminalFont } from './fonts';
import {
  sections,
  algorithmKeys,
  labels,
  settings,
  setting,
  get,
  set,
  format,
  formatCommand,
  type SectionId,
} from './spec-format';

type Method = NonNullable<NonNullable<Spec['auth']>['method']>;
type FieldValue = {
  mode: string;
  text: string;
  items: string[];
  pending: string;
  defined: boolean;
  badInput?: boolean;
};
type Definition = {
  kind?: 'choice' | 'list' | 'secret' | 'agent' | 'font';
  choices?: string[];
  boolean?: boolean;
  methods?: Method[];
  number?: [number, number];
  unit?: string;
  mono?: boolean;
  /** An empty value is a value of its own, shown with this placeholder. */
  empty?: string;
  placeholder?: string;
  browse?: boolean;
  required?: string;
};
const definitions: Record<string, Definition> = {
  label: {},
  host: { mono: true },
  username: { mono: true, empty: '' },
  port: { number: [1, 65535] },
  'auth.method': { kind: 'choice', choices: ['auto', 'agent', 'key', 'password', 'keyboard-interactive'] },
  'auth.identity_files': { kind: 'list', placeholder: 'Path', browse: true, methods: ['auto', 'key'] },
  'auth.agent': { kind: 'agent', methods: ['auto', 'agent'] },
  'auth.password': { kind: 'secret', methods: ['auto', 'password'] },
  'auth.passphrase': { kind: 'secret', methods: ['auto', 'key'] },
  'host_keys.policy': { kind: 'choice', choices: ['ask', 'strict', 'accept-new', 'off'] },
  'host_keys.fingerprints': { kind: 'list', placeholder: 'Fingerprint', required: 'Add at least one fingerprint' },
  'host_keys.public_keys': { kind: 'list', placeholder: 'Public key', required: 'Add at least one public key' },
  'terminal.font': { kind: 'font' },
  'terminal.font_size': { number: [8, 32], unit: 'px' },
  'terminal.ligatures': { kind: 'choice', boolean: true },
  'terminal.scrollback': { number: [0, 100000], unit: 'lines' },
  'ssh.ConnectTimeout': { number: [0, 86400], unit: 'seconds' },
  'ssh.ServerAliveInterval': { number: [0, 86400], unit: 'seconds' },
  'ssh.ServerAliveCountMax': { number: [0, 1000] },
  'ssh.ForwardAgent': { kind: 'choice', boolean: true },
  'ssh.Compression': { kind: 'choice', boolean: true },
  'ssh.TCPKeepAlive': { kind: 'choice', boolean: true },
  'ssh.AddressFamily': { kind: 'choice', choices: ['any', 'inet', 'inet6'] },
  'ssh.LogLevel': { kind: 'choice', choices: ['QUIET', 'FATAL', 'ERROR', 'INFO', 'VERBOSE'] },
  ...Object.fromEntries(algorithmKeys.map((key) => [`ssh.${key}`, { mono: true, empty: 'OpenSSH Default' }])),
};
const same = (a: unknown, b: unknown): boolean =>
  a === b ||
  (typeof a === 'object' &&
    typeof b === 'object' &&
    a !== null &&
    b !== null &&
    Array.isArray(a) === Array.isArray(b) &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([key, value]) => same(value, (b as Record<string, unknown>)[key])));
const idFor = (path: string) => `field-${path.replace(/[^A-Za-z0-9]/g, '-')}`;
function initial(path: string, value: unknown): FieldValue {
  const kind = definitions[path].kind;
  const result: FieldValue = { mode: '', text: '', items: [], pending: '', defined: value !== undefined };
  if (value === undefined) return result;
  if (kind === 'list') {
    result.items = value as string[];
    result.mode = result.items.length ? 'custom' : 'none';
  } else if (kind === 'secret') {
    const secret = value as { source: string; path?: string };
    result.mode = secret.source;
    result.text = secret.path ?? '';
  } else if (kind === 'agent') {
    result.mode = ['SSH_AUTH_SOCK', 'none'].includes(String(value)) ? String(value) : 'path';
    result.text = result.mode === 'path' ? String(value) : '';
  } else if (kind === 'choice') result.mode = String(value);
  else result.text = String(value);
  return result;
}
const listValues = (value: Pick<FieldValue, 'items' | 'pending'>) =>
  value.pending.trim() && !value.items.includes(value.pending.trim())
    ? [...value.items, value.pending.trim()]
    : [...value.items];
function read(path: string, value: FieldValue, baseline: unknown): unknown {
  const def = definitions[path];
  if (def.kind === 'font') return value.defined ? value.text.trim() : undefined;
  if (!def.kind) {
    if (def.number) {
      if (value.badInput) throw new Error('Enter a number');
      if (!value.text) return undefined;
      const number = Number(value.text),
        [min, max] = def.number;
      if (!Number.isInteger(number) || number < min || number > max)
        throw new Error(`Enter a whole number from ${min} to ${max}`);
      return number;
    }
    return value.text.trim() || (def.empty !== undefined && value.defined ? '' : undefined);
  }
  if (!value.mode) return undefined;
  if (def.kind === 'choice') return def.boolean ? value.mode === 'true' : value.mode;
  if (def.kind === 'agent') {
    if (value.mode !== 'path') return value.mode;
    if (!value.text.trim()) throw new Error('Enter a socket path');
    return value.text.trim();
  }
  if (def.kind === 'secret') {
    if (value.mode === 'prompt') return { source: 'prompt' };
    if (value.mode === 'literal')
      return value.text === '' && (baseline as { source?: string } | undefined)?.source === 'literal'
        ? { source: 'literal' }
        : { source: 'literal', value: value.text };
    return { source: 'file', path: value.text.trim() };
  }
  if (value.mode === 'none') return [];
  const items = listValues(value);
  if (!items.length && def.required) throw new Error(def.required);
  return items;
}
let opening = false,
  shown: { draft: ProfileDraft; error?: unknown } | undefined;
export function openConnection(profileId?: string, error?: unknown) {
  if (shown || opening) return;
  opening = true;
  void api
    .profileDraft(profileId)
    .then(
      (draft) => {
        if (!shown) {
          shown = { draft, error };
          render();
        }
      },
      (failure) => report('session', failure),
    )
    .finally(() => {
      opening = false;
    });
}
export function ConnectionForm() {
  return shown ? (
    <Editor key={shown.draft.token} draft={shown.draft} initialError={shown.error} />
  ) : (
    <dialog id="connection-dialog" className="form-dialog" />
  );
}
function ItemList({
  value,
  onChange,
  label,
  placeholder,
  mono = false,
  browse = false,
  id,
}: {
  value: Pick<FieldValue, 'items' | 'pending'>;
  onChange(value: Pick<FieldValue, 'items' | 'pending'>): void;
  label: string;
  placeholder: string;
  mono?: boolean;
  browse?: boolean;
  id?: string;
}) {
  const input = useRef<HTMLInputElement>(null),
    latest = useRef(value);
  latest.current = value;
  const add = (text: string) => {
    const entry = text.trim(),
      current = latest.current;
    onChange({
      items: entry && !current.items.includes(entry) ? [...current.items, entry] : current.items,
      pending: '',
    });
  };
  return (
    <div className="item-editor">
      <ul className="item-list">
        {value.items.map((item, index) => (
          <li key={item} className="item">
            <span className={`item-text${mono ? ' mono' : ''}`}>{item}</span>
            <IconButton
              icon="close"
              label={`Remove ${item}`}
              onClick={() => {
                onChange({ ...value, items: value.items.filter((_, i) => i !== index) });
                input.current!.focus();
              }}
            />
          </li>
        ))}
      </ul>
      <div className="item-add">
        <input
          ref={input}
          id={id}
          className={`input${mono ? ' mono' : ''}`}
          type="text"
          placeholder={placeholder}
          aria-label={label}
          autoComplete="off"
          spellCheck={false}
          value={value.pending}
          onChange={(e) => onChange({ ...value, pending: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(value.pending);
            }
          }}
        />
        <Button
          onClick={() => {
            add(value.pending);
            input.current!.focus();
          }}
        >
          Add
        </Button>
        {browse && store.state.capabilities.nativeFilePicker && (
          <Button
            className="browse"
            onClick={() =>
              void api.chooseFile().then((file) => {
                if (file) add(file);
              })
            }
          >
            Browse…
          </Button>
        )}
      </div>
    </div>
  );
}
function Control({
  path,
  value,
  update,
  inherited,
  inheritLabel,
  baseline,
  method,
  error,
}: {
  path: string;
  value: FieldValue;
  update(patch: Partial<FieldValue>): void;
  inherited: unknown;
  inheritLabel: string;
  baseline: unknown;
  method: Method;
  error?: string;
}) {
  const def = definitions[path],
    id = idFor(path),
    label = setting(path)[1];
  const validity = { 'aria-invalid': error ? true : undefined, 'aria-describedby': error ? `${id}-error` : undefined };
  const host = useRef<HTMLDivElement>(null);
  const focusDetail = () =>
    requestAnimationFrame(() => host.current?.querySelector<HTMLInputElement>('input:not([hidden])')?.focus());
  const select = (options: [string, string][], extra?: (mode: string) => void) => (
    <select
      {...validity}
      id={id}
      name={path}
      className="input"
      value={value.mode}
      onChange={(e) => {
        update({ mode: e.target.value });
        extra?.(e.target.value);
      }}
    >
      <option value="">{inheritLabel}</option>
      {options.map(([key, text]) => (
        <option key={key} value={key}>
          {text}
        </option>
      ))}
    </select>
  );
  if (!def.kind) {
    const input = (
      <input
        {...validity}
        id={id}
        name={path}
        className={`input${def.mono ? ' mono' : ''}`}
        type={def.number ? 'number' : 'text'}
        autoComplete="off"
        spellCheck={false}
        min={def.number?.[0]}
        max={def.number?.[1]}
        step={def.number ? 1 : undefined}
        value={value.text}
        placeholder={def.empty !== undefined && value.defined ? def.empty : format(path, inherited) || def.empty}
        onInput={(e) => {
          if (def.number && value.badInput !== e.currentTarget.validity.badInput)
            update({ badInput: e.currentTarget.validity.badInput, defined: true });
        }}
        onChange={(e) => update({ text: e.target.value, defined: true, badInput: e.target.validity.badInput })}
      />
    );
    return def.unit ? (
      <div className="with-unit">
        {input}
        <span className="unit">{def.unit}</span>
      </div>
    ) : (
      input
    );
  }
  if (def.kind === 'font')
    return (
      <FontPicker
        error={error}
        id={id}
        name={path}
        label={label}
        bundled={bundledTerminalFont}
        inherit={inheritLabel}
        value={value.defined ? value.text : undefined}
        onChange={(font) => update({ defined: font !== undefined, text: font ?? '' })}
      />
    );
  if (def.kind === 'choice')
    return select((def.choices ?? ['true', 'false']).map((key) => [key, (labels[path] ?? labels.boolean)[key] ?? key]));
  if (def.kind === 'agent')
    return (
      <div ref={host} className="stack">
        {select(
          [
            ['SSH_AUTH_SOCK', 'SSH_AUTH_SOCK'],
            ['none', 'None'],
            ['path', 'Socket Path'],
          ],
          (mode) => {
            if (mode === 'path') focusDetail();
          },
        )}
        <input
          className="input mono"
          type="text"
          placeholder="Path"
          aria-label="Agent Socket Path"
          autoComplete="off"
          spellCheck={false}
          hidden={value.mode !== 'path'}
          value={value.text}
          onChange={(e) => update({ text: e.target.value })}
        />
      </div>
    );
  if (def.kind === 'secret')
    return (
      <div ref={host} className="stack">
        {select(Object.entries(labels.secret), (mode) => {
          update({ mode, text: '' });
          if (['literal', 'file'].includes(mode)) focusDetail();
        })}
        <div className="inline" hidden={!['literal', 'file'].includes(value.mode)}>
          <input
            className={`input${value.mode === 'literal' ? '' : ' mono'}`}
            type={value.mode === 'literal' ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            name={`${path}.value`}
            aria-label={value.mode === 'file' ? `${label} File Path` : `${label} Value`}
            placeholder={
              value.mode === 'file'
                ? 'Path'
                : (baseline as { source?: string } | undefined)?.source === 'literal'
                  ? '••••••••'
                  : ''
            }
            value={value.text}
            onChange={(e) => update({ text: e.target.value })}
          />
          <Button
            className="browse"
            hidden={value.mode !== 'file' || !store.state.capabilities.nativeFilePicker}
            onClick={() =>
              void api.chooseFile().then((file) => {
                if (file) update({ text: file });
              })
            }
          >
            Browse…
          </Button>
        </div>
      </div>
    );
  return (
    <div ref={host} className="stack">
      {select(
        [
          ['none', format(path, [], method)],
          ['custom', 'Custom'],
        ],
        (mode) => {
          if (mode === 'custom') focusDetail();
        },
      )}
      <div hidden={value.mode !== 'custom'}>
        <ItemList
          value={value}
          onChange={update}
          mono
          placeholder={def.placeholder!}
          label={`Add ${label}`}
          browse={def.browse}
        />
      </div>
    </div>
  );
}
type FormError = { path?: string; message: string };
function Editor({ draft, initialError }: { draft: ProfileDraft; initialError?: unknown }) {
  const editing = draft.id !== undefined;
  const dialog = useRef<HTMLDialogElement>(null),
    panels = useRef<HTMLDivElement>(null),
    mounted = useRef(true),
    pending = useRef(false);
  const [values, setValues] = useState(() =>
    Object.fromEntries(settings.map(([path]) => [path, initial(path, get(draft.spec, path))])),
  );
  const [touched, setTouched] = useState(new Set<string>()),
    [tags, setTags] = useState({ items: draft.tags, pending: '' }),
    [tagsEdited, setTagsEdited] = useState(false);
  const [profileId, setProfileId] = useState(''),
    [section, setSection] = useState<SectionId>('connection');
  const [errors, setErrors] = useState<FormError[]>([]),
    [busy, setBusy] = useState<string>();
  const [previewOpen, setPreviewOpen] = useState(false),
    [preview, setPreview] = useState({ text: '', error: false });
  const inherited = (path: string) =>
    get(store.state.defaults, path) ??
    (
      {
        'terminal.font': store.state.settings.terminalFont,
        'terminal.font_size': store.state.settings.terminalFontSize,
        'terminal.ligatures': store.state.settings.terminalLigatures,
      } as Record<string, unknown>
    )[path];
  const method = (read('auth.method', values['auth.method'], undefined) ??
    inherited('auth.method') ??
    'auto') as Method;
  const relevant = (path: string) => !definitions[path]?.methods || definitions[path].methods!.includes(method);
  const inheritLabel = (path: string) => {
    const value = inherited(path);
    return value === undefined ? 'Inherit' : `Inherit (${format(path, value, method)})`;
  };
  const update = (path: string, patch: Partial<FieldValue>) => {
    setValues((previous) => ({ ...previous, [path]: { ...previous[path], ...patch } }));
    setTouched((previous) => new Set([...previous, path]));
  };
  function collect(): { changes: Omit<ProfileChanges, 'token'>; errors: FormError[] } {
    const changed: Record<string, unknown> = {},
      reset: string[] = [],
      issues: FormError[] = [];
    for (const [path] of settings) {
      if (!relevant(path) || !touched.has(path)) continue;
      try {
        const value = read(path, values[path], get(draft.spec, path));
        if (same(value, get(draft.spec, path))) continue;
        if (value === undefined) reset.push(path);
        else set(changed, path, value);
      } catch (error) {
        issues.push({ path, message: (error as Error).message });
      }
    }
    const tagValues = listValues(tags);
    return {
      changes: {
        values: changed as Spec,
        reset,
        ...(!tagsEdited || same(tagValues, draft.tags) ? {} : { tags: tagValues }),
      },
      errors: issues,
    };
  }
  const suggestedId = () => {
    const source = String(read('label', values.label, undefined) ?? read('host', values.host, undefined) ?? '');
    const base =
      source
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'profile';
    let id = base;
    for (let n = 2; store.state.profiles.some((profile) => profile.id === id); n++) id = `${base}-${n}`;
    return id;
  };
  function activate(id: SectionId) {
    setSection(id);
    if (panels.current) panels.current.scrollTop = 0;
  }
  function showErrors(issues: FormError[]) {
    setErrors(issues);
    const first = issues.find((issue) => issue.path && relevant(issue.path));
    if (first?.path) {
      activate(first.path === 'id' ? 'connection' : setting(first.path)[2]);
    }
  }
  useLayoutEffect(() => {
    const first = errors.find((issue) => issue.path && relevant(issue.path));
    if (first?.path) document.getElementById(first.path === 'id' ? 'field-profile-id' : idFor(first.path))?.focus();
  }, [errors]);
  function rejected(error: unknown, saving = false) {
    const { message, fields } = describeError(error);
    const byPath = (path: string) =>
      settings.find(([field]) => path === field || path.startsWith(`${field}.`))?.[0] ??
      (path === 'id' && !editing ? 'id' : undefined);
    const mapped = Object.entries(fields).map(([issue, message]) => {
      const key = issue.replace(/^values\./, ''),
        path = byPath(key);
      return { path, message: path ? message : `${key}: ${message}` };
    });
    showErrors(mapped.length ? mapped : [{ message: saving ? `${message}\n${draft.file}` : message }]);
  }
  useLayoutEffect(() => {
    openModal(
      dialog.current!,
      dialog.current!.querySelector<HTMLElement>(editing ? '[type="submit"]' : '[name="host"]')!,
    );
    if (initialError !== undefined) rejected(initialError);
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!previewOpen) return;
    let active = true;
    const timer = setTimeout(() => {
      const { changes, errors } = collect();
      if (errors.length) {
        setPreview({ text: errors.map((e) => e.message).join('\n'), error: true });
        return;
      }
      void api.profilePreview({ token: draft.token, ...changes }).then(
        (args) => {
          if (active) setPreview({ text: formatCommand(args), error: false });
        },
        (error) => {
          if (active) setPreview({ text: describeError(error).message, error: true });
        },
      );
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [previewOpen, values, tags, touched, store.state.defaults]);
  function closeThen(next: () => void) {
    if (!mounted.current || !dialog.current?.open) return;
    dialog.current.addEventListener('close', next, { once: true });
    dialog.current.close();
  }
  async function submit(action: 'connect' | 'save' | 'save-connect') {
    if (pending.current) return;
    const { changes, errors } = collect();
    if (errors.length) {
      showErrors(errors);
      return;
    }
    showErrors([]);
    pending.current = true;
    setBusy(action);
    try {
      if (action === 'connect') {
        const id = await api.profileConnect({ token: draft.token, ...changes });
        closeThen(() => focusConnection(id));
        return;
      }
      const result = await api.profileSave({
        token: draft.token,
        ...changes,
        ...(editing ? {} : { id: profileId.trim() || suggestedId() }),
        connect: action === 'save-connect',
      });
      if (result.connectionError !== undefined) {
        if (mounted.current) closeThen(() => openConnection(result.profileId, result.connectionError));
        else report('session', result.connectionError, result.connectionId);
      } else
        closeThen(() => {
          if (result.connectionId) focusConnection(result.connectionId);
        });
    } catch (error) {
      if (mounted.current) rejected(error, action !== 'connect');
      else report('session', error);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(undefined);
    }
  }
  const counts = new Map<SectionId, number>();
  const overridden = (path: string) => {
    try {
      return read(path, values[path], get(draft.spec, path)) !== undefined;
    } catch {
      return true;
    }
  };
  for (const [path, , section] of settings)
    if (relevant(path) && overridden(path)) counts.set(section, (counts.get(section) ?? 0) + 1);
  const { changes, errors: invalid } = collect();
  const retained = store.state.connections.find((connection) => connection.profileId === draft.id);
  const reconnectNotice =
    editing &&
    retained &&
    retained.status !== 'closed' &&
    (Object.keys(changes.values).length > 0 || changes.reset.length > 0 || invalid.length > 0);
  const general = errors
    .filter((error) => !error.path || !relevant(error.path))
    .map((error) => error.message)
    .join('\n');
  const errorFor = (path: string) => errors.find((error) => error.path === path && relevant(path))?.message;
  const source = store.state.profiles.find((profile) => profile.id === draft.id);
  const row = (label: string, id: string, control: ReactNode, error?: string) => (
    <div className={`field${error ? ' invalid' : ''}`}>
      <div className="field-head">
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
      </div>
      <div className="field-body">
        {control}
        <span className="field-reset-space" />
      </div>
      <p className="field-error" id={`${id}-error`} hidden={!error}>
        {error}
      </p>
    </div>
  );
  return (
    <dialog
      ref={dialog}
      id="connection-dialog"
      className="form-dialog"
      aria-labelledby="connection-title"
      onClose={() => {
        shown = undefined;
        render();
      }}
    >
      <form
        className="connection-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit(editing ? 'save' : 'connect');
        }}
      >
        <header className="dialog-header">
          <span className="dialog-icon">
            <Icon name="terminal" />
          </span>
          <div className="dialog-titles">
            <h2 id="connection-title">{source ? profileName(source) : (draft.id ?? 'New Connection')}</h2>
            {editing && <p className="dialog-context">{draft.id}</p>}
          </div>
        </header>
        <div className="form-layout">
          <div
            className="section-nav"
            role="tablist"
            aria-orientation="vertical"
            aria-label="Settings"
            onKeyDown={(event) => {
              if (!moveFocus([...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')], event.key, true)) return;
              event.preventDefault();
              activate(document.activeElement!.id.slice('tab-'.length) as SectionId);
            }}
          >
            {sections.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`section-tab${errors.some((error) => error.path && relevant(error.path) && (error.path === 'id' ? 'connection' : setting(error.path)[2]) === id) ? ' has-error' : ''}`}
                role="tab"
                id={`tab-${id}`}
                aria-controls={`panel-${id}`}
                aria-selected={id === section}
                tabIndex={id === section ? 0 : -1}
                onClick={() => activate(id)}
              >
                <span>{label}</span>
                <span className="section-count" hidden={!counts.get(id)}>
                  {counts.get(id) ?? 0}
                </span>
              </button>
            ))}
          </div>
          <div ref={panels} className="section-panels">
            {sections.map(([id, label]) => (
              <div
                key={id}
                className="section-panel"
                role="tabpanel"
                id={`panel-${id}`}
                aria-labelledby={`tab-${id}`}
                hidden={section !== id}
              >
                <h3 className="panel-title">{label}</h3>
                {id === 'connection' &&
                  !editing &&
                  row(
                    'Profile ID',
                    'field-profile-id',
                    <input
                      id="field-profile-id"
                      name="profile-id"
                      className="input mono"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={suggestedId()}
                      value={profileId}
                      onChange={(e) => setProfileId(e.target.value)}
                      aria-invalid={!!errorFor('id') || undefined}
                      aria-describedby={errorFor('id') ? 'field-profile-id-error' : undefined}
                    />,
                    errorFor('id'),
                  )}
                {settings
                  .filter(([, , section]) => section === id)
                  .map(([path, label]) => (
                    <Fragment key={path}>
                      <SettingField
                        path={path}
                        label={label}
                        overridden={overridden(path)}
                        hidden={!relevant(path)}
                        error={errorFor(path)}
                        reset={() => {
                          setValues((previous) => ({ ...previous, [path]: initial(path, undefined) }));
                          setTouched((previous) => new Set([...previous, path]));
                          requestAnimationFrame(() => document.getElementById(idFor(path))?.focus());
                        }}
                      >
                        <Control
                          path={path}
                          value={values[path]}
                          update={(patch) => update(path, patch)}
                          inherited={inherited(path)}
                          inheritLabel={inheritLabel(path)}
                          baseline={get(draft.spec, path)}
                          method={method}
                          error={errorFor(path)}
                        />
                      </SettingField>
                    </Fragment>
                  ))}
                {id === 'connection' &&
                  row(
                    'Tags',
                    'field-tags',
                    <div className="stack">
                      <ItemList
                        id="field-tags"
                        value={tags}
                        label="Add Tag"
                        placeholder="Tag"
                        onChange={(value) => {
                          setTags(value);
                          setTagsEdited(true);
                        }}
                      />
                    </div>,
                  )}
              </div>
            ))}
          </div>
        </div>
        <section className="command-preview" id="command-preview" hidden={!previewOpen}>
          <pre className={`command mono${preview.error ? ' error' : ''}`} tabIndex={0} aria-label="Command">
            {preview.text}
          </pre>
        </section>
        <div className="form-notice" hidden={!reconnectNotice}>
          <p role="status">Changes will apply when you reconnect.</p>
        </div>
        <footer className="dialog-actions">
          <Button
            className="ghost"
            aria-expanded={previewOpen}
            aria-controls="command-preview"
            onClick={() => setPreviewOpen(!previewOpen)}
          >
            Preview Command
          </Button>
          <p className="form-error" role="alert" hidden={!general}>
            {general}
          </p>
          <span className="spacer" />
          <Button onClick={() => dialog.current!.close()}>Cancel</Button>
          {!editing && (
            <>
              <Button disabled={!!busy} onClick={() => void submit('save')}>
                {busy === 'save' ? 'Saving…' : 'Save'}
              </Button>
              <Button disabled={!!busy} onClick={() => void submit('save-connect')}>
                {busy === 'save-connect' ? 'Connecting…' : 'Save and Connect'}
              </Button>
            </>
          )}
          <button type="submit" className="button primary" disabled={!!busy}>
            {editing ? (busy === 'save' ? 'Saving…' : 'Save') : busy === 'connect' ? 'Connecting…' : 'Connect'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
function SettingField({
  path,
  label,
  children,
  overridden,
  hidden,
  error,
  reset,
}: {
  path: string;
  label: string;
  children: ReactNode;
  overridden: boolean;
  hidden: boolean;
  error?: string;
  reset(): void;
}) {
  const id = idFor(path);
  return (
    <div
      className={`field${overridden ? ' overridden' : ''}${error ? ' invalid' : ''}`}
      data-path={path}
      hidden={hidden}
    >
      <div className="field-head">
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
      </div>
      <div className="field-body">
        {children}
        <IconButton
          icon="undo"
          label={`Reset ${label}`}
          className="field-reset"
          disabled={!overridden}
          onClick={reset}
        />
      </div>
      <p className="field-error" id={`${id}-error`} hidden={!error}>
        {error}
      </p>
    </div>
  );
}
const launching = new Set<string>();
export function connectProfile(profileId: string) {
  const active = activeConnection(profileId);
  if (active) {
    focusConnection(active.id);
    return;
  }
  if (launching.has(profileId)) return;
  launching.add(profileId);
  void api
    .connect({ profileId })
    .then(focusConnection, (error) => {
      if (shown) report('session', error);
      else openConnection(profileId, error);
    })
    .finally(() => launching.delete(profileId));
}
