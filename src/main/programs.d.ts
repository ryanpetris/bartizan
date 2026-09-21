/** Helper bootstraps are bundled as source text. */
declare module '*.py' {
  const program: string;
  export default program;
}

/** Python zipapps are bundled as base64. */
declare module '*.pyz' {
  const archive: string;
  export default archive;
}
