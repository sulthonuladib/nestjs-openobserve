import { Box, IconButton, InputBase, Stack, Tooltip } from "@mui/material";
import { ArrowsClockwise, MagnifyingGlass, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { colors } from "../../theme";
import { AppSwitcher } from "./AppSwitcher";
import { LiveToggle } from "./LiveToggle";
import { RangeDivider, RangePicker } from "./RangePicker";
import { useShell } from "./ShellContext";

/**
 * The top bar: search on the left, scope controls on the right.
 *
 * Left-to-right the controls read as a sentence, which is why they are in this
 * order: *which* applications (switcher), *how fresh* (live), *how far back*
 * (range), *fetch it again* (refresh). Every one of them writes to the URL except
 * live, which is a session setting.
 */
export function TopBar() {
  const { search, setSearch, refresh } = useShell();
  const [searchOpen, setSearchOpen] = useState(search !== "");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) input.current?.focus();
  }, [searchOpen]);

  // `/` opens the search field, `Esc` closes it. Both ignore keystrokes that are
  // already going into a field, so typing a slash into a query never steals focus.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable === true;

      if (event.key === "Escape") {
        if (searchOpen) {
          setSearch("");
          setSearchOpen(false);
          (event.target as HTMLElement | null)?.blur?.();
        }
        return;
      }

      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "/") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen, setSearch]);

  return (
    <Box
      component="div"
      sx={{
        position: "sticky",
        top: 0,
        zIndex: 20,
        display: "flex",
        alignItems: "center",
        gap: 2,
        minHeight: 52,
        px: { xs: 2, md: 3 },
        py: 1,
        backgroundColor: "rgba(13, 7, 9, 0.82)",
        backdropFilter: "blur(10px)",
      }}
    >
      {searchOpen ? (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.75,
            height: 30,
            px: 1.25,
            borderRadius: 1.25,
            border: `1px solid ${colors.borderStrong}`,
            backgroundColor: colors.page,
            minWidth: 220,
          }}
        >
          <MagnifyingGlass size={13} color={colors.faint} />
          <InputBase
            inputRef={input}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search…"
            aria-label="Search"
            inputProps={{ "aria-label": "Search" }}
            sx={{ fontSize: 12, flex: 1, "& input::placeholder": { color: colors.faint, opacity: 1 } }}
          />
          <IconButton
            size="small"
            aria-label="Close search"
            onClick={() => {
              setSearch("");
              setSearchOpen(false);
            }}
            sx={{ width: 20, height: 20 }}
          >
            <X size={12} />
          </IconButton>
        </Box>
      ) : (
        <Tooltip title="Search — press /">
          <IconButton aria-label="Search" onClick={() => setSearchOpen(true)}>
            <MagnifyingGlass size={15} />
          </IconButton>
        </Tooltip>
      )}

      <Stack direction="row" spacing={1} sx={{ alignItems: "center", ml: "auto" }}>
        <AppSwitcher />
        <LiveToggle />
        <RangePicker />
        <RangeDivider />
        <Tooltip title="Refresh now">
          <IconButton aria-label="Refresh data" onClick={refresh}>
            <ArrowsClockwise size={15} />
          </IconButton>
        </Tooltip>
      </Stack>
    </Box>
  );
}

export default TopBar;
