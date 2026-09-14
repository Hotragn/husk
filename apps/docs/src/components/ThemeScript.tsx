import { THEME_KEY } from '@/lib/theme';

/**
 * Applies the stored theme before first paint.
 *
 * This has to be a blocking inline script in `<head>`. Anything that runs after
 * hydration is too late: the reader gets a frame of the wrong theme, which on a
 * dark-default site is a white flash in a dark room.
 *
 * It only ever *sets* the attribute. With no stored choice the attribute stays
 * absent and the `prefers-color-scheme` block in tokens.css decides -- an
 * explicit choice beats an inferred one, and no choice means no override.
 */
export function ThemeScript() {
  const source = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="dark"||t==="light"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}`;
  return <script dangerouslySetInnerHTML={{ __html: source }} />;
}
