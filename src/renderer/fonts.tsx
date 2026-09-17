import { useEffect, useRef, useState } from 'react';
/** Fonts the application ships, named in configuration by their display names. */
export const bundledTerminalFont = 'JetBrains Mono';
export const bundledInterfaceFont = 'Inter';

/** A font family name as one quoted CSS family. */
export const quoteFont = (family: string) => `"${family.replace(/[\\"]/g, '\\$&')}"`;
/** CSS families for a configured terminal font: the bundled font, the system monospace font for an empty name, or a named family. */
export const terminalFontFamily = (name: string) =>
  name === bundledTerminalFont
    ? '"Bartizan JetBrains Mono", monospace'
    : name
      ? `${quoteFont(name)}, monospace`
      : 'monospace';
/** CSS families for a configured interface font: the bundled font, the system interface font for an empty name, or a named family. */
export const interfaceFontFamily = (name: string) =>
  name === bundledInterfaceFont
    ? '"Bartizan Inter", system-ui, sans-serif'
    : name
      ? `${quoteFont(name)}, system-ui, sans-serif`
      : 'system-ui, sans-serif';
/** Waits for the regular, bold, italic and bold italic faces of a font list at a size; a failed load leaves the fallbacks. */
export const loadFontStyles = (family: string, size: number) =>
  Promise.all(
    ['', 'bold ', 'italic ', 'italic bold '].map((style) => document.fonts.load(`${style}${size}px ${family}`)),
  ).then(
    () => {},
    () => {},
  );

type Installed = { all: string[]; monospace: string[] };
let installed: Promise<Installed> | undefined;
/** Installed font families, read once for every font picker: all families, and those whose glyphs measure as monospace. */
export function installedFonts(): Promise<Installed> {
  const query = (window as Window & { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
  if (!query) return Promise.resolve({ all: [], monospace: [] });
  return (installed ??= query.call(window).then(
    (fonts) => {
      const context = document.createElement('canvas').getContext('2d')!;
      const monospace = (family: string) => {
        context.font = `16px ${quoteFont(family)}, serif`;
        return context.measureText('i').width === context.measureText('W').width;
      };
      const all = [...new Set(fonts.map((entry) => entry.family))].sort((a, b) => a.localeCompare(b));
      return { all, monospace: all.filter(monospace) };
    },
    () => {
      installed = undefined;
      return { all: [], monospace: [] };
    },
  ));
}

const systemOption = ' system',
  customOption = ' custom';
export function FontPicker({
  id,
  label,
  bundled,
  inherit,
  value,
  onChange,
  onCommit,
  terminal = true,
  name,
  error,
}: {
  id: string;
  label: string;
  bundled: string;
  inherit?: string;
  value: string | undefined;
  /** `typed` is true for text typed into the family field, which `onCommit` confirms. */
  onChange(value: string | undefined, typed: boolean): void;
  onCommit?(): void;
  terminal?: boolean;
  name?: string;
  error?: string;
}) {
  const [names, setNames] = useState<string[]>([]),
    [custom, setCustom] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    void installedFonts().then((fonts) => {
      if (active) setNames(terminal ? fonts.monospace : fonts.all);
    });
    return () => {
      active = false;
    };
  }, [terminal]);
  const choice = custom
    ? customOption
    : value === undefined
      ? inherit
        ? ''
        : systemOption
      : value === ''
        ? systemOption
        : value === bundled || names.includes(value)
          ? value
          : customOption;
  const option = (family: string) => (
    <option key={family} value={family}>
      {family}
    </option>
  );
  return (
    <div className="stack">
      <select
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        id={id}
        name={name}
        className="input"
        value={choice}
        onChange={(event) => {
          const chosen = event.target.value;
          setCustom(chosen === customOption);
          if (chosen === customOption) requestAnimationFrame(() => input.current?.focus());
          else onChange(chosen === systemOption ? '' : chosen === '' ? undefined : chosen, false);
        }}
      >
        {inherit && <option value="">{inherit}</option>}
        {option(bundled)}
        <option value={systemOption}>System Default</option>
        {names.filter((family) => family !== bundled).map(option)}
        <option value={customOption}>Custom</option>
      </select>
      <input
        ref={input}
        className="input"
        type="text"
        aria-label={`${label} Family`}
        autoComplete="off"
        spellCheck={false}
        hidden={choice !== customOption}
        value={value ?? ''}
        onFocus={() => setCustom(true)}
        onChange={(event) => onChange(event.target.value, true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onCommit?.();
        }}
        onBlur={() => {
          onCommit?.();
          setCustom(false);
        }}
      />
    </div>
  );
}
