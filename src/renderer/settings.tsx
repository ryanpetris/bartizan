import { useLayoutEffect, useRef, useState } from 'react';
import type { Settings as SettingsValue } from '../shared';
import { Button, moveFocus } from './ui';
import { themeIds, themes } from '../themes';
import { registry } from './themes';
import { api, store, render, report } from './store';
import { openModal } from './dialogs';
import { ClosedDialog, Field, FormDialog, Sections } from './form-dialog';
import {
  FontPicker,
  interfaceFontFamily,
  terminalFontFamily,
  bundledInterfaceFont,
  bundledTerminalFont,
} from './fonts';
let opened = false;
export function openSettings() {
  if (!opened) {
    opened = true;
    render();
  }
}
export function Settings() {
  const current = store.state.settings;
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--font-ui', interfaceFontFamily(current.interfaceFont));
  }, [current.interfaceFont]);
  return opened ? <SettingsDialog /> : <ClosedDialog name="settings" />;
}
type SectionId = 'appearance' | 'terminal' | 'advanced';
const sections: readonly (readonly [SectionId, string])[] = [
  ['appearance', 'Appearance'],
  ['terminal', 'Terminal'],
  ['advanced', 'Advanced'],
];
/** Text typed into a field that is saved once confirmed. */
type Drafts = { interfaceFont?: string; terminalFont?: string; terminalFontSize?: string };
const validSize = (text: string) => /^\d+$/.test(text) && Number(text) >= 8 && Number(text) <= 32;
function SettingsDialog() {
  const dialog = useRef<HTMLDialogElement>(null),
    sizeInput = useRef<HTMLInputElement>(null),
    mounted = useRef(true);
  /** Changes on their way to the configuration file, shown until the saved settings arrive. */
  const [pending, setPending] = useState<Partial<SettingsValue>>({});
  const [drafts, setDrafts] = useState<Drafts>({});
  const [failure, setFailure] = useState('');
  const [section, setSection] = useState<SectionId>('appearance');
  const settings = { ...store.state.settings, ...pending };
  const latest = useRef(drafts);
  latest.current = drafts;
  function save(patch: Partial<SettingsValue>) {
    setPending((previous) => ({ ...previous, ...patch }));
    void api
      .settings(patch)
      .then(
        () => {
          if (mounted.current) setFailure('');
        },
        () => {
          // A save confirmed by closing the dialog can fail after it has closed.
          const message = `Could not save settings\n${store.state.file}`;
          if (dialog.current?.open) setFailure(message);
          else report('settings', message);
        },
      )
      .finally(() => {
        if (mounted.current)
          setPending((previous) =>
            Object.fromEntries(
              Object.entries(previous).filter(([key, value]) => patch[key as keyof SettingsValue] !== value),
            ),
          );
      });
  }
  /** Saves a confirmed draft; an invalid size returns to the saved value. */
  function commit(key: keyof Drafts) {
    const text = latest.current[key];
    if (text === undefined) return;
    latest.current = { ...latest.current, [key]: undefined };
    setDrafts(latest.current);
    const saved = store.state.settings;
    if (key !== 'terminalFontSize') {
      if (text.trim() !== saved[key]) save({ [key]: text.trim() });
    } else if (validSize(text) && Number(text) !== saved.terminalFontSize) save({ terminalFontSize: Number(text) });
  }
  useLayoutEffect(() => {
    openModal(dialog.current!, dialog.current!.querySelector('select')!);
    // A number field changes on each step of its spin buttons, and when typing is confirmed.
    const input = sizeInput.current!,
      confirm = () => commit('terminalFontSize');
    input.addEventListener('change', confirm);
    return () => {
      mounted.current = false;
      input.removeEventListener('change', confirm);
    };
  }, []);
  const picker = (key: 'interfaceFont' | 'terminalFont', id: string, label: string, bundled: string) => (
    <FontPicker
      id={id}
      label={label}
      bundled={bundled}
      terminal={key === 'terminalFont'}
      value={drafts[key] ?? settings[key]}
      onChange={(value, typed) => {
        if (typed) setDrafts((previous) => ({ ...previous, [key]: value ?? '' }));
        else save({ [key]: value ?? '' });
      }}
      onCommit={() => commit(key)}
    />
  );
  const size = drafts.terminalFontSize ?? String(settings.terminalFontSize);
  const invalid = drafts.terminalFontSize !== undefined && !validSize(drafts.terminalFontSize);
  const panel = (id: SectionId) => {
    if (id === 'appearance')
      return (
        <>
          <Field label="Appearance" id="settings-appearance">
            <select
              id="settings-appearance"
              className="input"
              value={settings.appearance}
              onChange={(e) => save({ appearance: e.target.value as SettingsValue['appearance'] })}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">System</option>
            </select>
          </Field>
          <Field label="Theme" id="settings-theme" group>
            <div
              className="theme-picker"
              role="radiogroup"
              aria-labelledby="settings-theme-label"
              onKeyDown={(event) => {
                const options = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')];
                const key = { ArrowLeft: 'ArrowUp', ArrowRight: 'ArrowDown' }[event.key] ?? event.key;
                if (!moveFocus(options, key, true)) return;
                event.preventDefault();
                (event.currentTarget.ownerDocument.activeElement as HTMLElement).click();
              }}
            >
              {themeIds.map((id) => {
                const { Preview } = registry[id];
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    id={`settings-theme-${id}`}
                    className="theme-option"
                    aria-checked={settings.theme === id}
                    tabIndex={settings.theme === id ? 0 : -1}
                    onClick={() => settings.theme !== id && save({ theme: id })}
                  >
                    <Preview />
                    <span>{themes[id].name}</span>
                  </button>
                );
              })}
            </div>
          </Field>
          {themes[settings.theme].interfaceFont !== false && (
            <Field label="Interface Font" id="settings-interface-font">
              {picker('interfaceFont', 'settings-interface-font', 'Interface Font', bundledInterfaceFont)}
            </Field>
          )}
        </>
      );
    if (id === 'terminal')
      return (
        <>
          <Field label="Terminal Font" id="settings-font">
            {picker('terminalFont', 'settings-font', 'Terminal Font', bundledTerminalFont)}
          </Field>
          <Field label="Terminal Font Size" id="settings-font-size" className={invalid ? 'invalid' : ''}>
            <div className="with-unit">
              <input
                ref={sizeInput}
                id="settings-font-size"
                className="input"
                type="number"
                min="8"
                max="32"
                step="1"
                value={size}
                aria-invalid={invalid || undefined}
                onChange={(e) => {
                  latest.current = { ...latest.current, terminalFontSize: e.target.value };
                  setDrafts(latest.current);
                }}
              />
              <span className="unit">px</span>
            </div>
          </Field>
          <Field label="Terminal Ligatures" id="settings-ligatures">
            <input
              id="settings-ligatures"
              type="checkbox"
              checked={settings.terminalLigatures}
              onChange={(e) => save({ terminalLigatures: e.target.checked })}
            />
          </Field>
          <pre
            className={`font-sample${settings.terminalLigatures ? '' : ' no-ligatures'}`}
            aria-hidden="true"
            style={{ fontFamily: terminalFontFamily(settings.terminalFont), fontSize: settings.terminalFontSize }}
          >
            {'AaBbCc 0O 1lI {}[]()\n-> => == != <= >= === !== && ||\n─┬─┼─┴─ ▁▃▅▇█ ░▒▓'}
          </pre>
        </>
      );
    return (
      <>
        <Field label="WebGL Rendering" id="settings-webgl">
          <input
            id="settings-webgl"
            type="checkbox"
            checked={settings.terminalWebgl}
            onChange={(e) => save({ terminalWebgl: e.target.checked })}
          />
        </Field>
        <Field label="Remote Sessions" id="settings-remote-sessions">
          <input
            id="settings-remote-sessions"
            type="checkbox"
            checked={settings.remoteSessionIntegration}
            onChange={(e) => save({ remoteSessionIntegration: e.target.checked })}
          />
        </Field>
      </>
    );
  };
  return (
    <FormDialog
      name="settings"
      dialog={dialog}
      icon="settings"
      title="Settings"
      actions={
        <>
          <p className="form-error" role="alert" hidden={!failure}>
            {failure}
          </p>
          <span className="spacer" />
          <Button onClick={() => dialog.current!.close()}>Close</Button>
        </>
      }
      onClose={() => {
        commit('interfaceFont');
        commit('terminalFont');
        commit('terminalFontSize');
        opened = false;
        render();
      }}
    >
      <Sections<SectionId> name="settings" label="Sections" sections={sections} active={section} onActivate={setSection}>
        {panel}
      </Sections>
    </FormDialog>
  );
}
