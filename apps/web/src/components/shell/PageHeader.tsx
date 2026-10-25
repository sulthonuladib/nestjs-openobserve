import { Box, Skeleton, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";
import { colors } from "../../theme";

/**
 * The page title block: one big title, one muted sentence, optional actions on
 * the right. Every page in the reference has exactly this, and it is the only
 * place the page name is spelled out — the sidebar item and the breadcrumb are
 * the shorthand.
 *
 * The props carry an index signature on purpose: pages are written by several
 * hands against this component and an extra attribute (a `subtitle`, a `meta`
 * strip) must not stop the build.
 */
export interface PageHeaderProps {
  title: ReactNode;
  /** One plain sentence: what this page shows and why it matters. */
  description?: ReactNode;
  /** Right-aligned controls (buttons, tabs, filters). */
  actions?: ReactNode;
  /** A square mark left of the title — the application avatar in the reference. */
  avatar?: ReactNode;
  /** Tighter vertical rhythm, for detail pages stacked under a back link. */
  dense?: boolean;
  children?: ReactNode;
  [extra: string]: unknown;
}

export function PageHeader({
  title,
  description,
  actions,
  avatar,
  dense = false,
  children,
}: PageHeaderProps) {
  return (
    <Box
      component="header"
      sx={{
        display: "flex",
        alignItems: "flex-start",
        gap: 2,
        flexWrap: "wrap",
        pt: dense ? 1 : 2,
        pb: dense ? 1.5 : 2.5,
      }}
    >
      {avatar}
      <Box sx={{ minWidth: 0, flex: "1 1 260px" }}>
        <Typography variant="h1" component="h1" sx={{ color: colors.text }}>
          {title}
        </Typography>
        {description ? (
          <Typography
            component="p"
            sx={{ mt: 0.75, maxWidth: 560, color: colors.muted, fontSize: 13, lineHeight: 1.55 }}
          >
            {description}
          </Typography>
        ) : null}
      </Box>
      {actions ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap", ml: "auto" }}>
          {actions}
        </Stack>
      ) : null}
      {children}
    </Box>
  );
}

/** A page-shaped skeleton: title, description, then a card grid. Never a blank screen. */
export function PageSkeleton() {
  return (
    <Box sx={{ pt: 2 }}>
      <Skeleton variant="text" width={220} height={34} />
      <Skeleton variant="text" width={420} height={18} sx={{ mt: 0.5 }} />
      <Box
        sx={{
          display: "grid",
          gap: 2,
          mt: 3,
          gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
        }}
      >
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} variant="rounded" height={190} />
        ))}
      </Box>
    </Box>
  );
}

/** The 10px letter-spaced label the reference puts above cards and groups. */
export function SectionLabel({ children, sx }: { children: ReactNode; sx?: object }) {
  return (
    <Typography
      component="div"
      sx={{
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.09em",
        textTransform: "uppercase",
        color: colors.faint,
        ...sx,
      }}
    >
      {children}
    </Typography>
  );
}

export default PageHeader;
