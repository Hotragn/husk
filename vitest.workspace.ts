/**
 * `npx vitest run` at the root has to mean "the whole repo", including the
 * console.
 *
 * The console's tests are React components in jsdom: they need its
 * `vitest.config.ts` (the react plugin, the node-builtin aliases from
 * `vite.config.ts`) to even transform. Without this file the root run collects
 * them with bare defaults and they fail for reasons that have nothing to do
 * with what they assert. The packages have no config of their own and keep the
 * defaults they always had.
 */
export default ['packages/*', 'apps/console/vitest.config.ts'];
