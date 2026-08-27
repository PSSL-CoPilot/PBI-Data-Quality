/**
 * Telling the shell that a detail panel is open.
 *
 * The content region has to give up the drawer's width so a table stays
 * readable beside it rather than underneath it. The drawers themselves are
 * rendered deep inside a view, so the shell cannot see them.
 *
 * The obvious CSS answer, `.shell:has(.drawer) .content { padding-right }`,
 * does not work here: the drawer is a *descendant* of the element being
 * styled, so applying the rule would change the layout that the selector
 * depends on. `:has()` matches in script and the rule is in the stylesheet,
 * but the style engine declines to apply it. Rather than build the layout on
 * something that quietly does nothing, presence is reported explicitly.
 *
 * A counter rather than a boolean, because a view may briefly render the next
 * drawer before the previous one unmounts, and the last teardown would
 * otherwise switch the layout off while a panel was still on screen.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

interface DrawerHost {
  open: boolean;
  register: () => () => void;
}

const Context = createContext<DrawerHost>({
  open: false,
  register: () => () => {},
});

export function DrawerHostProvider({ children }: { children: React.ReactNode }) {
  const [count, setCount] = useState(0);

  // Stable for the life of the provider. A fresh function each render would
  // make the registering effect tear down and re-run on every render, which
  // is an infinite loop rather than a subscription.
  const register = useCallback(() => {
    setCount((n) => n + 1);
    return () => setCount((n) => Math.max(0, n - 1));
  }, []);

  const value = useMemo(() => ({ open: count > 0, register }), [count, register]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** True while any drawer is mounted. */
export const useDrawerOpen = () => useContext(Context).open;

/** Called by a drawer to declare itself for as long as it is mounted. */
export function useDrawerPresence(): void {
  const { register } = useContext(Context);
  useEffect(register, [register]);
}
