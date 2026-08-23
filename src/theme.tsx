/**
 * Theme state.
 *
 * Three settings rather than two: light, dark, and "match my system", which is
 * the default so the app agrees with the machine on first load. The choice is
 * written to `data-theme` on the document element, which is what every stylesheet
 * and the code editor key off, and persisted so a reload keeps it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "pbi-quality-studio.theme";

function readStored(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" || value === "system" ? value : "system";
  } catch {
    return "system";
  }
}

const systemPrefersDark = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

interface ThemeContextValue {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  setChoice: (choice: ThemeChoice) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStored);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  // Follow the system while the choice is "system", including live changes.
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolved: ResolvedTheme =
    choice === "system" ? (systemDark ? "dark" : "light") : choice;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    // Lets form controls and scrollbars render in the matching scheme.
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A blocked storage quota must not stop the theme from changing.
    }
  }, []);

  const toggle = useCallback(
    () => setChoice(resolved === "dark" ? "light" : "dark"),
    [resolved, setChoice]
  );

  const value = useMemo(
    () => ({ choice, resolved, setChoice, toggle }),
    [choice, resolved, setChoice, toggle]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}

/**
 * Collapsed/expanded state for the navigation rail, persisted alongside the
 * theme so the layout a user settles on survives a reload.
 */
const NAV_KEY = "pbi-quality-studio.nav-collapsed";

export function useCollapsibleNav() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(NAV_KEY) === "1";
    } catch {
      return false;
    }
  });

  const toggle = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(NAV_KEY, next ? "1" : "0");
      } catch {
        // Ignore: the layout still toggles for this session.
      }
      return next;
    });
  }, []);

  return { collapsed, toggle };
}
