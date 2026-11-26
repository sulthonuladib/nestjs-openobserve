import { createTheme } from "@mui/material/styles";

/**
 * Design tokens, lifted from the reference dashboard (see
 * `docs/spec/screenshots/01-project-dashboard.png` and
 * `docs/spec/dashboard-features.md` §17).
 *
 * Near-black page, one step lighter panels, hairline borders, one hot pink
 * accent. Everything else is greyscale: hierarchy comes from type size, letter
 * spacing and spacing, never from colour. Charts, cards and pages all read these
 * values, so a token change here is a theme change everywhere.
 *
 * The type is deliberately loose (`Record<string, string>` in the intersection)
 * so a page can ask for a token this file has not named yet without breaking the
 * build; the literal keys still autocomplete.
 */
const tokens = {
  /** Page background — near-black with the faintest warm cast. */
  page: "#0d0709",
  /** Card / panel background, one step up from the page. */
  surface: "#150c10",
  /** Raised surface: menus, popovers, sticky headers. */
  surfaceRaised: "#1b1015",
  /** Hover / pressed background. */
  surfaceHover: "#241419",
  /** 1px hairline used for every border in the product. */
  border: "rgba(255, 255, 255, 0.06)",
  /** A border that has to be seen (inputs, focus, active chips). */
  borderStrong: "rgba(255, 255, 255, 0.14)",
  /** The one accent. */
  accent: "#ff2d55",
  /** Accent at 14% — active nav item, selected chip, tinted avatar. */
  accentSoft: "rgba(255, 45, 85, 0.14)",
  /** Accent readable on a dark background (chips, links). */
  accentText: "#ff5c7c",
  /** Primary text. */
  text: "#f6eff1",
  /** Secondary text: descriptions, axis labels. */
  muted: "#a0969b",
  /** Tertiary text: small-caps section labels, axis endpoints. */
  faint: "#6f646a",
  /** Status colours. */
  ok: "#46d39a",
  warn: "#f5b544",
  danger: "#ff4d5e",
  /** The LIVE dot. */
  live: "#38e8a4",
  /** Chart grid lines / axis rules. */
  grid: "rgba(255, 255, 255, 0.05)",
  /** Chart hairline between buckets in a bar series. */
  hairline: "rgba(255, 255, 255, 0.16)",
} as const;

export const colors: typeof tokens & Readonly<Record<string, string>> = tokens;

/** Aliases, so a component may say `colors.ink` as well as `colors.text`. */
export const aliases: Readonly<Record<string, string>> = {
  ink: colors.text,
  panel: colors.surface,
  panelRaised: colors.surfaceRaised,
  line: colors.border,
  brand: colors.accent,
};

export const chartColors = {
  line: colors.accent,
  lineSoft: "rgba(255, 45, 85, 0.35)",
  area: "rgba(255, 45, 85, 0.10)",
  bar: "rgba(255, 255, 255, 0.22)",
  barHot: colors.accentText,
  series: ["#ff5c7c", "#ffb3c1", "#8e8bff", "#46d39a", "#f5b544"] as const,
};

/**
 * The reference self-hosts Manrope Variable for UI and Geist Mono for numbers
 * and ids. We ship neither font file, so the stack asks for them first (a
 * workstation that has them gets the reference look) and falls back to the
 * system UI face, which is metric-similar.
 */
export const fontSans =
  '"Manrope Variable", Manrope, "Inter var", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const fontMono =
  '"Geist Mono Variable", "Geist Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

const sans = fontSans;

export const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: colors.accent, contrastText: "#ffffff" },
    secondary: { main: colors.muted },
    background: { default: colors.page, paper: colors.surface },
    text: { primary: colors.text, secondary: colors.muted, disabled: colors.faint },
    divider: colors.border,
    success: { main: colors.ok },
    warning: { main: colors.warn },
    error: { main: colors.danger },
    info: { main: "#7cc7ff" },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: sans,
    fontSize: 13,
    htmlFontSize: 16,
    h1: { fontSize: 26, fontWeight: 700, letterSpacing: "-0.015em", lineHeight: 1.15 },
    h2: { fontSize: 20, fontWeight: 650, letterSpacing: "-0.01em" },
    h3: { fontSize: 16, fontWeight: 650 },
    h4: { fontSize: 14, fontWeight: 600 },
    h5: { fontSize: 13, fontWeight: 600 },
    h6: { fontSize: 12, fontWeight: 600 },
    body1: { fontSize: 13, lineHeight: 1.5 },
    body2: { fontSize: 12, lineHeight: 1.5 },
    button: { fontSize: 11, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase" },
    caption: { fontSize: 11, color: colors.faint },
    /** The reference's small-caps section label: 10px, 0.09em tracking. */
    overline: {
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: "0.09em",
      textTransform: "uppercase",
      lineHeight: 1.6,
    },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: colors.page,
          color: colors.text,
          WebkitFontSmoothing: "antialiased",
          MozOsxFontSmoothing: "grayscale",
        },
        "::selection": { backgroundColor: colors.accentSoft, color: colors.text },
        "*": { scrollbarColor: `${colors.surfaceHover} transparent` },
        "*::-webkit-scrollbar": { width: 10, height: 10 },
        "*::-webkit-scrollbar-thumb": {
          backgroundColor: colors.surfaceHover,
          borderRadius: 9999,
          border: `2px solid ${colors.page}`,
        },
        "*::-webkit-scrollbar-track": { backgroundColor: "transparent" },
      },
    },
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: {
          backgroundImage: "none",
          backgroundColor: colors.surface,
          border: `1px solid ${colors.border}`,
        },
        rounded: { borderRadius: 10 },
      },
    },
    MuiCard: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: {
          backgroundColor: colors.surface,
          backgroundImage: "none",
          border: `1px solid ${colors.border}`,
          borderRadius: 10,
        },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true, size: "small" },
      styleOverrides: {
        root: {
          minHeight: 30,
          padding: "4px 12px",
          borderRadius: 8,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          fontWeight: 600,
          fontSize: 11,
        },
        contained: {
          color: "#fff",
          boxShadow: "none",
          "&:hover": { backgroundColor: "#ff4666", boxShadow: "none" },
        },
        outlined: { borderColor: colors.borderStrong, color: colors.text },
        text: { color: colors.muted },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          width: 30,
          height: 30,
          borderRadius: 8,
          color: colors.muted,
          "&:hover": { backgroundColor: colors.surfaceHover, color: colors.text },
        },
      },
    },
    MuiToggleButtonGroup: {
      styleOverrides: { root: { gap: 2, border: "none" } },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: {
          border: "1px solid transparent",
          borderRadius: "6px !important",
          padding: "3px 9px",
          minWidth: 34,
          color: colors.muted,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.07em",
          textTransform: "uppercase",
          "&:hover": { backgroundColor: colors.surfaceHover, color: colors.text },
          "&.Mui-selected": {
            backgroundColor: colors.text,
            color: colors.page,
            "&:hover": { backgroundColor: colors.text },
          },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          height: 20,
          borderRadius: 6,
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          borderColor: colors.borderStrong,
        },
        filled: { backgroundColor: colors.surfaceHover },
      },
    },
    MuiTable: { styleOverrides: { root: { borderCollapse: "separate" } } },
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderBottom: `1px solid ${colors.border}`,
          borderColor: colors.border,
          padding: "9px 12px",
          fontSize: 12.5,
        },
        head: {
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.09em",
          textTransform: "uppercase",
          color: colors.faint,
          backgroundColor: "transparent",
          whiteSpace: "nowrap",
        },
      },
    },
    MuiTableRow: {
      styleOverrides: {
        root: { "&:hover": { backgroundColor: "rgba(255,255,255,0.025)" } },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          minHeight: 30,
          padding: "4px 8px",
          borderRadius: 8,
          fontSize: 11.5,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: colors.muted,
          "&:hover": { backgroundColor: colors.surfaceHover, color: colors.text },
          "&.Mui-selected": {
            backgroundColor: colors.accentSoft,
            color: colors.text,
            "&:hover": { backgroundColor: colors.accentSoft },
          },
          "&.Mui-disabled": { color: colors.faint, opacity: 0.55 },
        },
      },
    },
    MuiListItemText: {
      styleOverrides: { primary: { fontSize: 11.5, letterSpacing: "0.08em" } },
    },
    MuiTooltip: {
      defaultProps: { arrow: true, enterDelay: 350 },
      styleOverrides: {
        tooltip: {
          backgroundColor: colors.surfaceRaised,
          border: `1px solid ${colors.borderStrong}`,
          borderRadius: 8,
          color: colors.text,
          fontSize: 11,
          lineHeight: 1.5,
          padding: "6px 9px",
          maxWidth: 280,
        },
        arrow: { color: colors.borderStrong },
      },
    },
    MuiSelect: { defaultProps: { size: "small" } },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          fontSize: 12,
          backgroundColor: colors.page,
          borderRadius: 8,
          "& .MuiOutlinedInput-notchedOutline": { borderColor: colors.border },
          "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: colors.borderStrong },
          "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
            borderColor: colors.accent,
            borderWidth: 1,
          },
        },
        input: { padding: "6px 10px" },
      },
    },
    MuiMenu: {
      styleOverrides: {
        paper: {
          backgroundColor: colors.surfaceRaised,
          border: `1px solid ${colors.borderStrong}`,
          borderRadius: 10,
          minWidth: 200,
          marginTop: 4,
        },
        list: { padding: 4 },
      },
    },
    MuiMenuItem: {
      styleOverrides: {
        root: {
          fontSize: 12,
          borderRadius: 6,
          minHeight: 32,
          padding: "4px 8px",
          "&.Mui-selected": { backgroundColor: colors.accentSoft },
        },
      },
    },
    MuiSkeleton: {
      defaultProps: { animation: "wave" },
      styleOverrides: {
        root: { backgroundColor: "rgba(255,255,255,0.055)", borderRadius: 6 },
        wave: { "&::after": { background: `linear-gradient(90deg, transparent, ${colors.surfaceRaised}, transparent)` } },
      },
    },
    MuiDivider: { styleOverrides: { root: { borderColor: colors.border } } },
    MuiBadge: {
      styleOverrides: {
        badge: {
          minWidth: 17,
          height: 17,
          padding: "0 4px",
          fontSize: 10,
          fontWeight: 600,
          backgroundColor: colors.surfaceRaised,
          border: `1px solid ${colors.borderStrong}`,
          color: colors.text,
        },
      },
    },
    MuiAvatar: {
      styleOverrides: {
        root: {
          width: 22,
          height: 22,
          fontSize: 10,
          fontWeight: 700,
          backgroundColor: colors.accentSoft,
          color: colors.accentText,
          border: `1px solid rgba(255,45,85,0.25)`,
        },
      },
    },
    MuiTabs: {
      styleOverrides: {
        root: { minHeight: 36, borderBottom: `1px solid ${colors.border}` },
        indicator: { backgroundColor: colors.accent, height: 1 },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          minHeight: 36,
          minWidth: 0,
          padding: "6px 12px",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: colors.faint,
          "&.Mui-selected": { color: colors.text },
        },
      },
    },
    MuiLink: {
      styleOverrides: {
        root: { color: colors.accentText, textDecorationColor: "rgba(255,92,124,0.4)" },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: { backgroundColor: colors.surfaceRaised, border: `1px solid ${colors.border}`, fontSize: 12 },
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: { backgroundColor: colors.surfaceHover, height: 2 },
        bar: { backgroundColor: colors.accent },
      },
    },
  },
});

/** Tabular figures, for every column of numbers. */
export const tabular = { fontVariantNumeric: "tabular-nums" } as const;

/** The small-caps label the reference puts over every card and group. */
export const labelCaps = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  color: colors.faint,
} as const;
