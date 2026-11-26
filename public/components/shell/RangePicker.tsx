import { Box, ToggleButton, ToggleButtonGroup, Tooltip } from "@mui/material";
import { colors } from "../../theme";
import { isRange, RANGES, useShell } from "./ShellContext";

/**
 * The range chips: `1H 24H 3D 7D 30D`.
 *
 * The selected chip is filled with the text colour (light on dark) and the rest
 * are plain, which is how the reference separates "what you are looking at" from
 * "what you could look at". The value is `?range=` — the URL is the state, so a
 * window is pasteable into a chat.
 */
export function RangePicker() {
  const { range, setRange } = useShell();

  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={range}
      onChange={(_, next: string | null) => {
        if (isRange(next)) setRange(next);
      }}
      aria-label="Time range"
      sx={{ height: 30 }}
    >
      {RANGES.map((entry) => (
        <Tooltip key={entry.id} title={`Last ${describe(entry.id)}`} enterDelay={500}>
          <ToggleButton value={entry.id} aria-label={`Last ${describe(entry.id)}`}>
            {entry.label}
          </ToggleButton>
        </Tooltip>
      ))}
    </ToggleButtonGroup>
  );
}

function describe(id: string): string {
  switch (id) {
    case "1h":
      return "hour";
    case "24h":
      return "24 hours";
    case "3d":
      return "3 days";
    case "7d":
      return "7 days";
    default:
      return "30 days";
  }
}

/** The little divider the reference draws between the chips and the refresh. */
export function RangeDivider() {
  return <Box sx={{ width: 1, height: 18, backgroundColor: colors.border, mx: 0.5 }} />;
}

export default RangePicker;
