import { useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Box,
  Collapse,
  Divider,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  CaretDown,
  ChartLineUp,
  EnvelopeSimple,
  Gear,
  Key,
  SignOut,
  SquaresFour,
  Stack,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { auth } from "../../api";
import { colors } from "../../theme";
import { useShell } from "./ShellContext";

/**
 * The project sidebar: three levels (dashboard, applications, activity), then
 * the tail the reference keeps at the bottom (notifications, support, log out).
 *
 * Navigation is per application — Requests, Jobs, Errors, Users and the rest all
 * address one application — so the app-scoped items point at the shell's
 * *effective* application: the one in the URL, else the one in `?app=`, else the
 * first application that exists. When no application exists yet, they render
 * disabled with a tooltip instead of linking somewhere that 404s.
 *
 * Anything the product has a name for but we have no page for renders **disabled
 * with a `soon` tooltip**. A dead link is worse than an honest grey row.
 */
export const SIDEBAR_WIDTH = 256;

interface Item {
  label: string;
  icon?: React.ReactNode;
  /** Route to open; `null` means "no page yet". */
  to: string | null;
  /** Why it is not linkable — shown in the tooltip, defaults to `soon`. */
  hint?: string;
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pathname } = useLocation();
  const { navAppId, notifications, user } = useShell();
  const [activityOpen, setActivityOpen] = useState(true);

  const app = navAppId ? `/applications/${navAppId}` : null;
  const noApp = "Link an application first — the CLI device-code flow is at /link.";

  const top: Item[] = [
    { label: "Dashboard", icon: <SquaresFour size={15} />, to: "/" },
    {
      label: "Applications",
      icon: <Stack size={15} />,
      to: null,
      hint: "The application list lands with the multi-application view.",
    },
  ];

  const activity: Item[] = [
    { label: "Requests", to: app, hint: noApp },
    { label: "Profiler", to: null, hint: "The SDK's CPU profiler is shelved upstream, so we do not ship a flamegraph." },
    { label: "Jobs", to: app ? `${app}/jobs` : null, hint: noApp },
    { label: "Errors", to: app ? `${app}/errors` : null, hint: noApp },
    { label: "Users", to: app ? `${app}/users` : null, hint: noApp },
    { label: "Spans", to: app ? `${app}/executions` : null, hint: noApp },
    { label: "Custom", to: app ? `${app}/metrics` : null, hint: noApp },
    { label: "Services", to: null, hint: "Per-class own/total time is not collected yet." },
    { label: "Map", to: null, hint: "The service graph needs edge data the collector does not emit." },
    { label: "Releases", to: app ? `${app}/releases` : null, hint: noApp },
    { label: "SLOs", to: null, hint: "No SLO evaluator on the server yet." },
    { label: "Logs", to: app ? `${app}/logs` : null, hint: noApp },
  ];

  const tail: Item[] = [
    { label: "API keys", icon: <Key size={15} />, to: null, hint: "Key management is admin-only and lives on the server first." },
    { label: "Members", icon: <Stack size={15} />, to: null, hint: "Member management is admin-only and lives on the server first." },
    { label: "Settings", icon: <Gear size={15} />, to: null, hint: "Project settings are not built yet." },
  ];

  const go = (to: string) => {
    navigate(to);
    onNavigate?.();
  };

  const signOut = async () => {
    await auth.logout().catch(() => undefined);
    queryClient.clear();
  };

  return (
    <Box
      component="aside"
      sx={{
        width: SIDEBAR_WIDTH,
        flex: `0 0 ${SIDEBAR_WIDTH}px`,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        borderRight: `1px solid ${colors.border}`,
        backgroundColor: "rgba(11, 6, 8, 0.6)",
      }}
    >
      {/* Breadcrumb: the reference puts it at the very top of the sidebar, above
          the first nav item, in faint small caps. */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          px: 2,
          height: 42,
          flex: "0 0 42px",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.09em",
          textTransform: "uppercase",
          color: colors.faint,
        }}
      >
        <Box
          component="button"
          type="button"
          onClick={() => go("/")}
          sx={{
            all: "unset",
            cursor: "pointer",
            "&:hover": { color: colors.text },
          }}
        >
          Dashboard
        </Box>
        <Box component="span" aria-hidden="true" sx={{ opacity: 0.6 }}>
          ›
        </Box>
        <Box component="span" sx={{ color: colors.muted }}>
          Project
        </Box>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 1.25, pb: 2 }}>
        <List disablePadding>
          {top.map((item) => (
            <Row key={item.label} item={item} pathname={pathname} onGo={go} />
          ))}

          <ListItemButton
            onClick={() => setActivityOpen((open) => !open)}
            aria-expanded={activityOpen}
            sx={{ mt: 0.25, gap: 1 }}
          >
            <ListItemIcon sx={{ minWidth: 0, color: "inherit" }}>
              <Box
                sx={{
                  display: "grid",
                  placeItems: "center",
                  transform: activityOpen ? "none" : "rotate(-90deg)",
                  transition: "transform 140ms ease",
                }}
              >
                <CaretDown size={13} weight="bold" />
              </Box>
            </ListItemIcon>
            <ListItemText primary="Activity" />
            <Box component="span" sx={{ ml: "auto", opacity: 0.55, display: "grid", placeItems: "center" }}>
              <ChartLineUp size={13} />
            </Box>
          </ListItemButton>

          <Collapse in={activityOpen} timeout={140} unmountOnExit>
            <Box
              sx={{
                ml: 1.4,
                pl: 1.25,
                my: 0.5,
                borderLeft: `1px solid rgba(255,255,255,0.09)`,
              }}
            >
              {activity.map((item) => (
                <Row key={item.label} item={item} pathname={pathname} onGo={go} sub />
              ))}
            </Box>
          </Collapse>

          <Divider sx={{ my: 1 }} />

          {tail.map((item) => (
            <Row key={item.label} item={item} pathname={pathname} onGo={go} />
          ))}
        </List>
      </Box>

      <Box sx={{ borderTop: `1px solid ${colors.border}`, px: 1.25, py: 1 }}>
        <List disablePadding>
          <Tooltip title="The notification centre is not built yet." placement="right">
            <Box component="span">
              <ListItemButton disabled>
                <ListItemIcon sx={{ minWidth: 0, mr: 1.25, color: "inherit" }}>
                  <EnvelopeSimple size={15} />
                </ListItemIcon>
                <ListItemText primary="Notifications" />
                <Box sx={{ ml: "auto" }}>
                  <Badge badgeContent={notifications} showZero={false} max={99} />
                </Box>
              </ListItemButton>
            </Box>
          </Tooltip>

          <ListItemButton onClick={() => window.open("/api/docs", "_blank", "noopener")}>
            <ListItemIcon sx={{ minWidth: 0, mr: 1.25, color: "inherit" }}>
              <EnvelopeSimple size={15} />
            </ListItemIcon>
            <ListItemText primary="Support" />
          </ListItemButton>

          <ListItemButton onClick={() => void signOut()} aria-label={`Log out ${user.email}`}>
            <ListItemIcon sx={{ minWidth: 0, mr: 1.25, color: "inherit" }}>
              <SignOut size={15} />
            </ListItemIcon>
            <ListItemText primary="Log out" />
          </ListItemButton>
        </List>
      </Box>
    </Box>
  );
}

function Row({
  item,
  pathname,
  onGo,
  sub = false,
}: {
  item: Item;
  pathname: string;
  onGo: (to: string) => void;
  sub?: boolean;
}) {
  const active = item.to !== null && isActive(item.to, pathname);
  const body = (
    <ListItemButton
      disabled={item.to === null}
      selected={active}
      aria-current={active ? "page" : undefined}
      onClick={() => item.to && onGo(item.to)}
      sx={{
        mt: 0.25,
        gap: 1.25,
        // Sub-items line up with the labels above them, not with the icons: the
        // hairline sits in the icon column, exactly as in the reference.
        pl: sub ? 2.2 : 1,
        // The reference marks the active row with a hairline instead of a glow.
        ...(active && {
          backgroundColor: colors.accentSoft,
          boxShadow: "inset 0 0 0 1px rgba(255,45,85,0.32)",
          color: colors.text,
        }),
      }}
    >
      {item.icon ? (
        <ListItemIcon sx={{ minWidth: 0, mr: 1.25, color: "inherit" }}>{item.icon}</ListItemIcon>
      ) : null}
      <ListItemText
        primary={item.label}
        slotProps={{
          primary: {
            sx: {
              fontSize: 11.5,
              fontWeight: 600,
              letterSpacing: "0.085em",
              textTransform: "uppercase",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            },
          },
        }}
      />
      {item.to === null ? (
        <Typography
          component="span"
          sx={{ fontSize: 9, letterSpacing: "0.08em", color: colors.faint, opacity: 0.75 }}
        >
          SOON
        </Typography>
      ) : null}
    </ListItemButton>
  );

  if (item.to !== null) return body;

  return (
    <Tooltip
      title={item.hint ? `${item.label} — ${item.hint}` : `${item.label} — soon`}
      placement="right"
    >
      {/* Disabled buttons do not emit pointer events; the span around them does,
          which is what makes the tooltip reachable at all. */}
      <Box component="span">{body}</Box>
    </Tooltip>
  );
}

/** Exact match, or a path prefix for pages that hang off a list page. */
function isActive(to: string, pathname: string): boolean {
  if (pathname === to) return true;
  if (to === "/") return false;
  return pathname.startsWith(`${to}/`);
}

export default Sidebar;
