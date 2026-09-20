/** Helper programs are bundled as text, so the application carries them rather than distributing them beside it. */
declare module '*.py' {
  const program: string;
  export default program;
}
