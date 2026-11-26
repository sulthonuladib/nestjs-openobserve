import { useQuery } from "@tanstack/react-query";
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
import { useLocation } from "react-router-dom";
import { alerts, auth } from "../../api";
import { colors } from "../../theme";
import { useShell } from "./ShellContext";
import { isActive } from "./active";

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
  /** A count to show on the right (open incidents). */
  badge?: number;
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const queryClient = useQueryClient();
  const { pathname } = useLocation();
  // The shell's navigate, not react-router's: it carries the view settings you
  // already made (range, search, app filter) into the next page instead of
  // resetting them, which is what a bare `navigate(path)` does.
  const { notifications, user, navigate, interval } = useShell();
  const [activityOpen, setActivityOpen] = useState(true);

  // Open incidents, for the badge. One small request per poll interval, and only
  // when LIVE is on — the sidebar already refreshes the pending-links badge this
  // way, so this does not add a timer of its own.
  const incidents = useQuery({
    queryKey: ["alerts", "incidents"],
    queryFn: alerts.incidents,
    refetchInterval: interval,
    retry: false,
  });
  const openAlerts = incidents.data?.items.length ?? 0;

  /**
   * Every activity page is **project-scoped**; the application is the filter in
   * `?app=`, which `navigate` carries across pages for you. That is why none of
   * these rows can be disabled for lack of an application any more — "all
   * applications" is a scope these pages actually implement, and a greyed-out
   * row was the old workaround for them not doing so.
   */

  const top: Item[] = [
    { label: "Dashboard", icon: <SquaresFour size={15} />, to: "/" },
    { label: "Applications", icon: <Stack size={15} />, to: "/applications" },
  ];

  const activity: Item[] = [
    { label: "Requests", to: "/requests" },
    { label: "Profiler", to: "/runtime", hint: "Runtime heartbeat — CPU, heap, event loop, GC. The SDK's sampling profiler is shelved upstream, so there is no flamegraph." },
    { label: "Jobs", to: "/jobs" },
    { label: "Alerts", to: "/alerts", badge: openAlerts },
    { label: "Errors", to: "/errors" },
    { label: "Users", to: "/users" },
    { label: "Spans", to: "/spans" },
    { label: "Custom", to: "/metrics" },
    { label: "Services", to: "/services" },
    { label: "Map", to: "/map" },
    { label: "Releases", to: "/releases" },
    { label: "SLOs", to: "/slos" },
    { label: "Logs", to: "/logs" },
  ];

  const tail: Item[] = [
    { label: "API keys", icon: <Key size={15} />, to: "/api-keys" },
    { label: "Members", icon: <Stack size={15} />, to: "/members" },
    { label: "Settings", icon: <Gear size={15} />, to: "/settings" },
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
      {/* Header: the product mark, and nothing else.
         
          It used to say `DASHBOARD › PROJECT`. There is exactly one project per
          install today — `project_id` is stamped on every row at bootstrap and
          nothing in the UI can create or switch one — so the second crumb was a
          fiction. A breadcrumb with one level is noise; when projects become
          real (docs/PLAN.md §7.1) this is where the project switcher goes. */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 2,
          height: 42,
          flex: "0 0 42px",
        }}
      >
        <Box
          component="button"
          type="button"
          aria-label="NestJS OpenObserve — dashboard"
          onClick={() => go("/")}
          sx={{
            all: "unset",
            display: "flex",
            alignItems: "center",
            gap: 1,
            cursor: "pointer",
            "&:hover": { color: colors.text },
          }}
        >
          <BrandMark />
          <Typography
            component="span"
            sx={{
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: "0.09em",
              textTransform: "uppercase",
              color: colors.faint,
            }}
          >
            NestJS OpenObserve
          </Typography>
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

/** The product mark, drawn inline so the chrome makes no asset request. */
function BrandMark() {
  return (
    <Box component="svg" viewBox="0 0 28 28" width={18} height={18} aria-hidden="true">
      <g fill={colors.accent}>
        <rect x="2.5" y="7.4" width="9" height="3.4" rx="1.7" transform="rotate(-24 7 9.1)" />
        <rect x="12.3" y="5.2" width="13" height="3.4" rx="1.7" transform="rotate(-24 18.8 6.9)" />
        <rect x="6" y="15.6" width="16" height="3.4" rx="1.7" transform="rotate(-24 14 17.3)" />
      </g>
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
      ) : item.badge && item.badge > 0 ? (
        <Box
          component="span"
          sx={{
            ml: "auto",
            minWidth: 16,
            px: 0.5,
            py: 0.1,
            borderRadius: 0.75,
            fontSize: 9.5,
            fontWeight: 700,
            fontVariantNumeric: "tabular-nums",
            textAlign: "center",
            color: colors.accentText,
            backgroundColor: colors.accentSoft,
            boxShadow: `inset 0 0 0 1px rgba(255,45,85,0.28)`,
          }}
        >
          {item.badge > 99 ? "99+" : item.badge}
        </Box>
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

export default Sidebar;
