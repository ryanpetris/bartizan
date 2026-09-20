import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { Icon, moveFocus, type IconName } from './ui';

/**
 * A dialog that edits settings: a header, a body and a row of actions. `name` gives the dialog its id, `settings-dialog`
 * for the name `settings`, and names the elements its parts refer to. With `onSubmit` the body is a form.
 */
export function FormDialog({
  name,
  dialog,
  icon,
  title,
  context,
  actions,
  onSubmit,
  onClose,
  children,
}: {
  name: string;
  dialog: RefObject<HTMLDialogElement | null>;
  icon: IconName;
  title: ReactNode;
  context?: ReactNode;
  actions: ReactNode;
  onSubmit?(): void;
  onClose(): void;
  children: ReactNode;
}) {
  const body = (
    <>
      <header className="dialog-header">
        <span className="dialog-icon">
          <Icon name={icon} />
        </span>
        <div className="dialog-titles">
          <h2 id={`${name}-title`}>{title}</h2>
          {context !== undefined && <p className="dialog-context">{context}</p>}
        </div>
      </header>
      {children}
      <footer className="dialog-actions">{actions}</footer>
    </>
  );
  return (
    <dialog
      ref={dialog}
      id={`${name}-dialog`}
      className="form-dialog"
      aria-labelledby={`${name}-title`}
      onClose={onClose}
    >
      {onSubmit ? (
        <form
          className="form-shell"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {body}
        </form>
      ) : (
        <div className="form-shell">{body}</div>
      )}
    </dialog>
  );
}
/** The dialog in its place while it is closed. */
export function ClosedDialog({ name }: { name: string }) {
  return <dialog id={`${name}-dialog`} className="form-dialog" />;
}
/**
 * The sections of a form beside the fields of the one in view, which `children` draws. A section keeps its fields while
 * another is shown, and the panel returns to its top as the section changes. `badge` counts what a section holds and
 * `invalid` marks the sections with an error.
 */
export function Sections<Id extends string>({
  name,
  label,
  sections,
  active,
  onActivate,
  badge,
  invalid,
  children,
}: {
  name: string;
  label: string;
  sections: readonly (readonly [Id, string])[];
  active: Id;
  onActivate(id: Id): void;
  badge?(id: Id): number | undefined;
  invalid?(id: Id): boolean;
  children(id: Id): ReactNode;
}) {
  const panels = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (panels.current) panels.current.scrollTop = 0;
  }, [active]);
  return (
    <div className="form-layout">
      <div
        className="section-nav"
        role="tablist"
        aria-orientation="vertical"
        aria-label={label}
        onKeyDown={(event) => {
          if (!moveFocus([...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')], event.key, true)) return;
          event.preventDefault();
          onActivate((event.currentTarget.ownerDocument.activeElement as HTMLElement).dataset.section as Id);
        }}
      >
        {sections.map(([id, text]) => (
          <button
            key={id}
            type="button"
            className={`section-tab${invalid?.(id) ? ' has-error' : ''}`}
            role="tab"
            id={`${name}-tab-${id}`}
            data-section={id}
            aria-controls={`${name}-panel-${id}`}
            aria-selected={id === active}
            tabIndex={id === active ? 0 : -1}
            onClick={() => onActivate(id)}
          >
            <span>{text}</span>
            <span className="section-count" hidden={!badge?.(id)}>
              {badge?.(id) ?? 0}
            </span>
          </button>
        ))}
      </div>
      <div ref={panels} className="section-panels">
        {sections.map(([id, text]) => (
          <div
            key={id}
            className="section-panel"
            role="tabpanel"
            id={`${name}-panel-${id}`}
            aria-labelledby={`${name}-tab-${id}`}
            hidden={active !== id}
          >
            <h3 className="panel-title">{text}</h3>
            {children(id)}
          </div>
        ))}
      </div>
    </div>
  );
}
/**
 * A setting's label beside its control, with its error below. `trailing` follows the control, as the button that resets
 * a connection setting does, and `group` labels a set of controls rather than one, by `${id}-label`.
 */
export function Field({
  label,
  id,
  group = false,
  error,
  trailing,
  className = '',
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  label: string;
  id: string;
  group?: boolean;
  error?: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div {...props} className={`field ${className}`.trim()}>
      <div className="field-head">
        {group ? (
          <span className="field-label" id={`${id}-label`}>
            {label}
          </span>
        ) : (
          <label className="field-label" htmlFor={id}>
            {label}
          </label>
        )}
      </div>
      <div className="field-body">
        {children}
        {trailing}
      </div>
      <p className="field-error" id={`${id}-error`} hidden={!error}>
        {error}
      </p>
    </div>
  );
}
