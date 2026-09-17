import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { Icon, Button, colorStyle, type IconName } from './ui';
import { browserSessionName, type AuthChallenge as Challenge, type AuthAnswer } from '../shared';
import { api, store, describeError, connectionOf, endpoint, sessionColor, render } from './store';
import { openModal } from './dialogs';
const answered = new Set<string>();
export function Challenges() {
  for (const id of answered) if (!store.state.challenges.some((c) => c.id === id)) answered.delete(id);
  const active = useRef<string | undefined>(undefined);
  const pending = store.state.challenges.filter((challenge) => !answered.has(challenge.id));
  const challenge = pending.find((challenge) => challenge.id === active.current) ?? pending[0];
  active.current = challenge?.id;
  return challenge ? (
    <ChallengeDialog key={challenge.id} challenge={challenge} />
  ) : (
    <dialog id="auth-dialog" className="prompt-dialog" />
  );
}
function ChallengeDialog({ challenge }: { challenge: Challenge }) {
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null),
    username = useRef<HTMLInputElement>(null),
    primary = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef(false),
    mounted = useRef(true);
  const website = 'workspaceId' in challenge;
  const workspace = website ? store.state.workspaces.find((w) => w.id === challenge.workspaceId) : undefined;
  const connection = connectionOf(
    'connectionId' in challenge ? challenge.connectionId : (workspace?.connectionId ?? ''),
  );
  const context = connection
    ? `${connection.label} · ${workspace ? browserSessionName(workspace) : endpoint(connection)}`
    : '';
  const trust = 'prompt' in challenge ? challenge.hostKey : undefined;
  const passphrase = 'prompt' in challenge && challenge.secret === 'passphrase';
  const password = 'prompt' in challenge && challenge.secret === 'password';
  const title = website
    ? 'Website Sign-In'
    : challenge.notification
      ? 'Authentication'
      : trust
        ? 'Trust host?'
        : challenge.confirm
          ? 'Confirm'
          : passphrase
            ? 'Key Passphrase'
            : password
              ? 'Password'
              : 'Authentication';
  const icon: IconName = website
    ? 'globe'
    : challenge.notification
      ? 'key'
      : trust || challenge.confirm
        ? 'shield'
        : passphrase
          ? 'key'
          : 'lock';
  const color = workspace && sessionColor(workspace);
  async function answer(value: AuthAnswer) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await api.answer(challenge.id, value);
      if (mounted.current) {
        answered.add(challenge.id);
        dialog.current?.close();
        render();
      }
    } catch (failure) {
      if (mounted.current) {
        setError(describeError(failure).message);
        setBusy(false);
        requestAnimationFrame(() => (username.current ?? input.current ?? primary.current)?.focus());
      }
    } finally {
      pending.current = false;
    }
  }
  useLayoutEffect(() => {
    const node = dialog.current!;
    openModal(
      node,
      username.current ??
        input.current ??
        (website || (!website && challenge.confirm && !trust)
          ? primary.current!
          : node.querySelector<HTMLButtonElement>('button')!),
    );
    return () => {
      mounted.current = false;
      if (node.open) node.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      id="auth-dialog"
      className="prompt-dialog"
      aria-labelledby="auth-title"
      onCancel={(e) => {
        e.preventDefault();
        void answer(null);
      }}
    >
      <form
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!website && challenge.notification) return;
          void answer(
            website
              ? { username: username.current!.value, password: input.current!.value }
              : trust || challenge.confirm
                ? 'yes'
                : input.current!.value,
          );
        }}
      >
        <header className="dialog-header">
          <span className={`dialog-icon${color ? ' session-badge' : ''}`} style={colorStyle(color)}>
            <Icon name={icon} />
          </span>
          <div className="dialog-titles">
            <h2 id="auth-title">{title}</h2>
            {context && <p className="dialog-context">{context}</p>}
          </div>
        </header>
        {website ? (
          <>
            <dl className="facts">
              <dt>Website</dt>
              <dd className="mono">{challenge.origin}</dd>
              {challenge.realm && (
                <>
                  <dt>Realm</dt>
                  <dd>{challenge.realm.length > 80 ? challenge.realm.slice(0, 80) + '…' : challenge.realm}</dd>
                </>
              )}
            </dl>
            <div className="stack-field">
              <label htmlFor="auth-username">Username</label>
              <input
                ref={username}
                type="text"
                id="auth-username"
                className="input"
                autoComplete="off"
                spellCheck={false}
                maxLength={4096}
                disabled={busy}
              />
            </div>
            <div className="stack-field">
              <label htmlFor="auth-response">Password</label>
              <input
                ref={input}
                type="password"
                id="auth-response"
                className="input"
                autoComplete="off"
                maxLength={4096}
                disabled={busy}
              />
            </div>
          </>
        ) : (
          <>
            {trust?.fingerprint ? (
              <>
                <dl className="facts">
                  {[
                    ['Host', trust.host],
                    ['Key Type', trust.algorithm],
                    ['Fingerprint', trust.fingerprint],
                  ]
                    .filter(([, value]) => value)
                    .map(([term, value]) => (
                      <Fragment key={term}>
                        <dt>{term}</dt>
                        <dd className="mono">{value}</dd>
                      </Fragment>
                    ))}
                </dl>
                {trust.notes.length > 0 && <pre className="prompt">{trust.notes.join('\n')}</pre>}
              </>
            ) : (
              <pre className="prompt">{challenge.prompt.trim()}</pre>
            )}
            {!trust && !challenge.notification && !challenge.confirm && (
              <div className="stack-field">
                <label htmlFor="auth-response">{passphrase ? 'Passphrase' : password ? 'Password' : 'Response'}</label>
                <input
                  ref={input}
                  type="password"
                  id="auth-response"
                  className="input"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </div>
            )}
          </>
        )}
        <p className="dialog-error" role="alert" hidden={!error}>
          {error}
        </p>
        <footer className="dialog-actions">
          <Button disabled={busy} onClick={() => void answer(null)}>
            Cancel
          </Button>
          {(website || !challenge.notification) && (
            <button ref={primary} type="submit" className="button primary" disabled={busy}>
              {website ? 'Sign In' : trust ? 'Trust Host' : challenge.confirm ? 'Accept' : 'Continue'}
            </button>
          )}
        </footer>
      </form>
    </dialog>
  );
}
