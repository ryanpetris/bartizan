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
/** Installed font families, cached for every picker; a worker reads each family's regular face for fixed-pitch metadata. */
export function installedFonts(): Promise<Installed> {
  type Font = { family: string; style: string; postscriptName: string; blob(): Promise<Blob> };
  const query = (window as Window & { queryLocalFonts?: () => Promise<Font[]> }).queryLocalFonts;
  if (!query) return Promise.resolve({ all: [], monospace: [] });
  return (installed ??= query.call(window).then(async (fonts) => {
    const families = new Map<string, Font>();
    for (const font of fonts)
      if (!families.has(font.family) || /^(regular|normal|book|roman)$/i.test(font.style)) families.set(font.family, font);
    const all = [...families.keys()].sort((a, b) => a.localeCompare(b)), monospace: string[] = [];
    let worker: Worker | undefined;
    try {
      worker = process.env.NODE_ENV === 'development'
        ? new Worker(new URL('./font-worker.ts', import.meta.url), { type: 'module' })
        : new Worker(new URL('font-worker.js', location.href));
      let failed = false;
      // Read one font at a time so font files do not accumulate in memory.
      for (const family of all) {
        if (failed) break;
        const font = families.get(family)!;
        const fixed = await new Promise<boolean>((resolve) => {
          worker!.onmessage = ({ data }: MessageEvent<boolean>) => resolve(data);
          worker!.onerror = (event) => { event.preventDefault(); failed = true; resolve(false); };
          void font.blob().then((blob) => {
            if (!failed) worker!.postMessage({ blob, postscriptName: font.postscriptName });
          }).catch(() => resolve(false));
        });
        if (fixed) monospace.push(family);
      }
    } finally { worker?.terminate(); }
    return { all, monospace };
  }).catch(() => {
    installed = undefined;
    return { all: [], monospace: [] };
  }));
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
  const [names, setNames] = useState<string[]>(),
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
        : value === bundled || names?.includes(value)
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
        disabled={!names}
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
        {names?.filter((family) => family !== bundled).map(option)}
        <option value={customOption}>Custom</option>
      </select>
      <input
        disabled={!names}
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
