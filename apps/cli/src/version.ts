declare const __JANUS_VERSION__: string | undefined;
/** The CLI's version: injected by build.mjs; 'dev' when run from source (tests). */
export const VERSION = typeof __JANUS_VERSION__ === 'string' ? __JANUS_VERSION__ : 'dev';
