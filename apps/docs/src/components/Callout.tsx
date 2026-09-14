import type { ReactNode } from 'react';

/**
 * Four callouts, and no more.
 *
 * `Note` is context. `Warning` is something that will cost you time. `Danger`
 * is something that will cost you data. `NotYet` is the honest one: a
 * capability the documentation would otherwise be describing as if it existed.
 *
 * Each carries a text label as well as a colour, because colour is never the
 * only channel (UI-PRINCIPLES section 7).
 */

function Callout({
  kind,
  label,
  children,
}: {
  kind?: 'warn' | 'danger' | 'notyet';
  label: string;
  children: ReactNode;
}) {
  return (
    <aside className={kind ? `callout callout-${kind}` : 'callout'}>
      <strong className="callout-label">{label}</strong>
      {children}
    </aside>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <Callout label="Note">{children}</Callout>;
}

export function Warning({ children }: { children: ReactNode }) {
  return (
    <Callout kind="warn" label="Careful">
      {children}
    </Callout>
  );
}

export function Danger({ children }: { children: ReactNode }) {
  return (
    <Callout kind="danger" label="Not recoverable">
      {children}
    </Callout>
  );
}

/**
 * A capability that is specified, named in the CLI help, or present in the
 * type system, but not implemented in the code as it stands.
 *
 * These exist because the alternative is worse in both directions: documenting
 * it as working sends someone to a wall, and quietly omitting it leaves them
 * wondering why the flag in `--help` does nothing.
 */
export function NotYet({ children }: { children: ReactNode }) {
  return (
    <Callout kind="notyet" label="Not yet">
      {children}
    </Callout>
  );
}
