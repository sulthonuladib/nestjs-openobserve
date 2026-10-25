import { Avatar, Box, MenuItem, Select, Stack, Typography } from "@mui/material";
import { SquaresFour } from "@phosphor-icons/react";
import { colors } from "../../theme";
import { useShell } from "./ShellContext";

/**
 * Application scope — the reference's `All applications` dropdown.
 *
 * `All applications` means *no* `applicationId` on any telemetry query, which is
 * why it maps to an empty `?app=` rather than to a sentinel id. The avatar letter
 * is the same affordance their menu uses; without an icon set per application it
 * is the only thing that makes a long list scannable.
 */
export function AppSwitcher() {
  const { appId, apps, appsLoading, setAppId } = useShell();

  return (
    <Select
      value={appId}
      onChange={(event) => setAppId(String(event.target.value))}
      displayEmpty
      aria-label="Application scope"
      renderValue={(selected) => {
        const id = String(selected ?? "");
        const app = apps.find((entry) => entry.id === id);
        if (!app) {
          return (
            <Stack direction="row" spacing={0.875} sx={{ alignItems: "center" }}>
              <Box
                sx={{
                  width: 18,
                  height: 18,
                  borderRadius: 0.75,
                  display: "grid",
                  placeItems: "center",
                  color: colors.muted,
                  border: `1px solid ${colors.border}`,
                }}
              >
                <SquaresFour size={11} />
              </Box>
              <Typography component="span" sx={{ fontSize: 12, color: colors.text }}>
                All applications
              </Typography>
            </Stack>
          );
        }
        return (
          <Stack direction="row" spacing={0.875} sx={{ alignItems: "center" }}>
            <Avatar variant="rounded" sx={{ width: 18, height: 18, fontSize: 9, borderRadius: 0.75 }}>
              {initial(app.name)}
            </Avatar>
            <Typography
              component="span"
              sx={{ fontSize: 12, color: colors.text, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {app.name}
            </Typography>
          </Stack>
        );
      }}
      sx={{
        minWidth: 196,
        height: 30,
        backgroundColor: colors.page,
        "& .MuiSelect-select": { py: 0.5, pl: 1.25, display: "flex", alignItems: "center" },
        "& .MuiOutlinedInput-notchedOutline": { borderColor: colors.border },
      }}
    >
      <MenuItem value="">
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Box sx={{ width: 18, display: "grid", placeItems: "center", color: colors.muted }}>
            <SquaresFour size={12} />
          </Box>
          <Typography component="span" sx={{ fontSize: 12 }}>
            All applications
          </Typography>
        </Stack>
      </MenuItem>

      {appsLoading && apps.length === 0 ? (
        <MenuItem value="" disabled>
          <Typography component="span" sx={{ fontSize: 12, color: colors.faint }}>
            Loading applications…
          </Typography>
        </MenuItem>
      ) : null}

      {!appsLoading && apps.length === 0 ? (
        <MenuItem value="" disabled>
          <Typography component="span" sx={{ fontSize: 12, color: colors.faint }}>
            No applications yet
          </Typography>
        </MenuItem>
      ) : null}

      {apps.map((app) => (
        <MenuItem key={app.id} value={app.id}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
            <Avatar variant="rounded" sx={{ width: 18, height: 18, fontSize: 9, borderRadius: 0.75 }}>
              {initial(app.name)}
            </Avatar>
            <Typography
              component="span"
              sx={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {app.name}
            </Typography>
          </Stack>
        </MenuItem>
      ))}
    </Select>
  );
}

/** First letter of the application name, uppercased: `storefront` → `S`. */
function initial(name: string): string {
  const first = name.trim().slice(0, 1);
  return first ? first.toUpperCase() : "?";
}

export default AppSwitcher;
