// Virtual module the bundler (build.mjs) serves: the text of chai's browser build, as pinned by @apijanus/core.
declare module 'janus:chai-source' {
  const source: string;
  export default source;
}
