import { useLayoutEffect } from 'react';
import { Button } from './ui';
import { store, dialogOpen, onFocusRequest } from './store';
import { Brand } from './chrome';
import { Connect, focus } from './connect';
import { openConnection } from './connection-form';

/** The page in view while nothing is selected: the brand, then Connect over every profile. Choosing Home focuses Connect. */
export function Home() {
  useLayoutEffect(
    () =>
      onFocusRequest(() => {
        if (!store.selection && !dialogOpen()) focus();
      }),
    [],
  );
  return (
    <section className="view home-view" aria-labelledby="home-title">
      <div className="home">
        <header className="home-brand">
          <Brand />
          <h1 className="home-title" id="home-title">
            Bartizan
          </h1>
        </header>
        <div className="home-head">
          <h2 className="home-heading">Profiles</h2>
          <Button icon="plus" aria-haspopup="dialog" onClick={() => openConnection()}>
            New Connection
          </Button>
        </div>
        <Connect listed />
      </div>
    </section>
  );
}
