/**
 * Bun's Fullstack Dev Server treats a CSS import as an entrypoint (it bundles
 * Tailwind and rewrites the link), but TypeScript has no idea what a `.css`
 * specifier is. There is no Vite client types package here, so one declaration
 * covers both `public/index.tsx` importing its stylesheet and any future one.
 */
declare module "*.css";
