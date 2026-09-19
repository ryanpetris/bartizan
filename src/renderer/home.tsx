import { Brand } from './chrome';

/** The page in view while nothing is selected: the brand over its name. */
export function Home() {
  return (
    <section className="view home-view" aria-labelledby="home-title">
      <header className="home-brand">
        <Brand />
        <h1 className="home-title" id="home-title">
          Bartizan
        </h1>
      </header>
    </section>
  );
}
