import { Box, ButtonBase, Tooltip } from "@mui/material";
import { colors } from "../../theme";
import { LIVE_INTERVAL_MS, useShell } from "./ShellContext";

/**
 * `LIVE` — the only control that changes what every other widget *does*.
 *
 * On: every query in the tree refetches every ten seconds, and the dot pulses.
 * Off: nothing polls; the refresh button still works. The value lives in the shell
 * (and in `localStorage`), so it survives navigation, and pages read it through
 * `useLive()` rather than each deciding for itself.
 */
export function LiveToggle() {
  const { live, setLive } = useShell();
  const seconds = Math.round(LIVE_INTERVAL_MS / 1000);

  return (
    <Tooltip
      title={
        live
          ? `Charts and tables refresh every ${seconds} seconds.`
          : "Polling is off. Data is only as fresh as the last fetch."
      }
    >
      <ButtonBase
        aria-pressed={live}
        aria-label={live ? "Turn live updates off" : "Turn live updates on"}
        onClick={() => setLive(!live)}
        sx={{
          height: 30,
          px: 1.25,
          gap: 0.875,
          display: "flex",
          alignItems: "center",
          borderRadius: 1.25,
          border: `1px solid ${live ? "rgba(56,232,164,0.42)" : colors.border}`,
          backgroundColor: live ? "rgba(56,232,164,0.10)" : "transparent",
          color: live ? colors.live : colors.faint,
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: "0.09em",
          textTransform: "uppercase",
          transition: "background-color 140ms ease, border-color 140ms ease, color 140ms ease",
          "&:hover": {
            backgroundColor: live ? "rgba(56,232,164,0.16)" : colors.surfaceHover,
          },
        }}
      >
        <Box
          className={live ? "live-dot" : undefined}
          sx={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: live ? colors.live : "transparent",
            border: live ? "none" : `1px solid ${colors.faint}`,
          }}
        />
        Live
      </ButtonBase>
    </Tooltip>
  );
}

export default LiveToggle;
