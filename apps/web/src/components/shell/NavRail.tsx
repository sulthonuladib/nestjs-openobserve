import { Box, Divider, IconButton, Tooltip } from "@mui/material";
import { ChartLineUp, ListBullets, SidebarSimple, SquaresFour } from "@phosphor-icons/react";
import { useLocation, useNavigate } from "react-router-dom";
import { colors } from "../../theme";
import { useShell } from "./ShellContext";

/**
 * The 56px icon rail down the left edge — the narrowest thing that can still say
 * "you are in Observe, and here is the level you are on".
 *
 * Its buttons are *places*, not tabs: dashboard (all applications), the request
 * list for the current application, the execution/trace list, then the sidebar
 * toggle. The active one carries a soft accent wash, the only pink furniture in
 * the chrome.
 */
export function NavRail() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { navAppId, collapsed, toggleCollapsed } = useShell();

  const appBase = navAppId ? `/applications/${navAppId}` : null;
  const onDashboard = pathname === "/";
  const onRequests = Boolean(appBase) && pathname === appBase;
  const onActivity =
    Boolean(appBase) &&
    (pathname === `${appBase}/executions` || pathname.startsWith("/executions/"));

  return (
    <Box
      component="nav"
      aria-label="Levels"
      sx={{
        width: 56,
        flex: "0 0 56px",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        py: 1.5,
        gap: 0.5,
        borderRight: `1px solid ${colors.border}`,
        backgroundColor: colors.page,
      }}
    >
      <Tooltip title="NestJS Observe" placement="right">
        <Box
          component="button"
          type="button"
          aria-label="NestJS Observe"
          onClick={() => navigate("/")}
          sx={{
            width: 32,
            height: 32,
            mb: 1.5,
            p: 0,
            border: 0,
            background: "transparent",
            cursor: "pointer",
            display: "grid",
            placeItems: "center",
          }}
        >
          <BrandMark />
        </Box>
      </Tooltip>

      <RailButton label="Dashboard" active={onDashboard} onClick={() => navigate("/")}>
        <SquaresFour size={17} weight="regular" />
      </RailButton>

      <RailButton
        label="Requests"
        active={onRequests}
        disabled={!appBase}
        onClick={() => appBase && navigate(appBase)}
      >
        <ListBullets size={17} />
      </RailButton>

      <RailButton
        label="Executions"
        active={onActivity}
        disabled={!appBase}
        onClick={() => appBase && navigate(`${appBase}/executions`)}
      >
        <ChartLineUp size={17} />
      </RailButton>

      <Divider flexItem sx={{ my: 1, mx: 1.5 }} />

      <RailButton
        label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        active={false}
        onClick={toggleCollapsed}
      >
        <Box sx={{ display: "grid", placeItems: "center", transform: collapsed ? "scaleX(-1)" : "none" }}>
          <SidebarSimple size={17} />
        </Box>
      </RailButton>
    </Box>
  );
}

function RailButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip title={label} placement="right">
      {/* A disabled MUI button swallows pointer events, and a tooltip on a
          disabled control is the one place the user needs it most: wrap instead. */}
      <Box component="span" sx={{ display: "grid", placeItems: "center" }}>
        <IconButton
          aria-label={label}
          aria-current={active ? "page" : undefined}
          size="small"
          disabled={disabled}
          onClick={onClick}
          sx={{
            width: 32,
            height: 32,
            borderRadius: 1.5,
            color: active ? colors.text : colors.muted,
            backgroundColor: active ? colors.accentSoft : "transparent",
            boxShadow: active ? `inset 0 0 0 1px rgba(255,45,85,0.28)` : "none",
            "&:hover": { backgroundColor: active ? colors.accentSoft : colors.surfaceHover },
          }}
        >
          {children}
        </IconButton>
      </Box>
    </Tooltip>
  );
}

/** Three slanted bars — the product mark, drawn inline so no asset request. */
function BrandMark() {
  return (
    <Box component="svg" viewBox="0 0 28 28" width={24} height={24} aria-hidden="true">
      <g fill={colors.accent}>
        <rect x="2.5" y="7.4" width="9" height="3.4" rx="1.7" transform="rotate(-24 7 9.1)" />
        <rect x="12.3" y="5.2" width="13" height="3.4" rx="1.7" transform="rotate(-24 18.8 6.9)" />
        <rect x="6" y="15.6" width="16" height="3.4" rx="1.7" transform="rotate(-24 14 17.3)" />
      </g>
    </Box>
  );
}

export default NavRail;
