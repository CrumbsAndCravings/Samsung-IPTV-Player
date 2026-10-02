// Replaced by esbuild at build time (tools/build.mjs).
declare const __APP_VERSION__: string;
declare const __DEV__: boolean;
// personal.json, for a personal build (tools/build.mjs); null otherwise.
declare const __PERSONAL__: unknown;

// Stylesheets are bundled by esbuild.
declare module "*.css";
