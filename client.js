/**
 * Client half of the 短考 / 长考 bundle: one small chip in the composer's
 * right-hand control row.
 *
 * The chip **reads** the mode from the host's `shortlong` session projection —
 * a value pushed with the session, never a command. Reading used to execute
 * `/mode status`, and every admitted command execution is logged and rendered
 * as a `>_ mode · 短考` line, so merely opening a session (or flipping back and
 * forth between sessions) piled those lines up in the transcript.
 *
 * Clicking still executes `/mode`, so a real switch keeps its line: the host
 * stays the single source of truth for both the state and the marker.
 *
 * The click's own settlement text outranks the projection on purpose: a stale
 * client-side projection snapshot pinned the chip on 短考 while the host had
 * already switched. Flip locally first, then let the host's answer correct it.
 * Clicks closer than 400 ms are ignored, so a double-fire cannot toggle twice
 * and cancel itself out.
 */
window.__ModuleLoader__.load({
  id: "@todrink/dsh-shortlong",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const SHORT = "short";
    const LONG = "long";

    /** Projection key owned by the host half. */
    const PROJECTION_KEY = "shortlong";

    /** Stable stand-in so the hook order survives a host half without projections. */
    const NO_PROJECTION = () => undefined;

    /** Last mode reported by the command path, per session; a bridge for hosts without the projection. */
    const commandedMode = new Map();

    /** `长考` / `→ 长考` / anything else → the mode word decides. */
    const parseMode = (text) => (typeof text === "string" && text.indexOf("长考") !== -1 ? LONG : SHORT);

    /**
     * The projection wire value carries the internal mode string (`"short"` /
     * `"long"`), not the Chinese label. Parsing it with `parseMode` made every
     * value read as 短考 — the chip looked stuck on short after a remount and
     * after every app restart, even though the host was in long mode.
     */
    const parseWireMode = (value) => (value === LONG ? LONG : value === SHORT ? SHORT : null);

    const buttonStyle = (isLong, busy) => ({
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      height: "26px",
      padding: "0 10px",
      border: "none",
      borderRadius: "999px",
      cursor: busy ? "progress" : "pointer",
      opacity: busy ? 0.6 : 1,
      font: "inherit",
      fontSize: "12px",
      lineHeight: "26px",
      whiteSpace: "nowrap",
      background: isLong ? "rgba(240,160,32,0.16)" : "transparent",
      color: isLong ? "#f0a020" : "var(--dsw-alias-label-tertiary, #8a8a8a)",
      transition: "background 120ms ease, color 120ms ease",
    });

    const dotStyle = (isLong) => ({
      display: "inline-block",
      width: "6px",
      height: "6px",
      borderRadius: "50%",
      background: isLong ? "#f0a020" : "currentColor",
      opacity: isLong ? 1 : 0.5,
    });

    function ModeChip(props) {
      const { read, toggle, getCached } = props;
      const useProjection = typeof props.useProjection === "function" ? props.useProjection : NO_PROJECTION;
      // Hook order is stable: the fallback is a fixed module function, not a
      // conditional call.
      const projection = useProjection(PROJECTION_KEY);
      const projected = parseWireMode(projection?.mode);

      // Seed from the last answer this client received for the Session. The
      // chip remounts whenever the user switches away and comes back; without
      // this seed it renders 短考 for the first frame(s) and stays there if the
      // projection is absent or stale (a cached list row, or a baseline that
      // has not landed yet). The command path is the authority right after a
      // click, so its remembered value must survive the remount.
      const [fallback, setFallback] = React.useState(() => {
        if (typeof getCached !== "function") return null;
        try {
          return getCached();
        } catch {
          return null;
        }
      });
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      /** Debounce: one click must never toggle twice (a fast double-fire cancels itself out). */
      const lastClickAt = React.useRef(0);

      const describe = (reason) => {
        if (reason === null || reason === undefined) return "未知错误";
        if (typeof reason === "string") return reason;
        if (typeof reason.message === "string") return reason.message;
        return String(reason);
      };

      // Bridge only for a host without the projection: wait briefly for the
      // Session baseline/frame, and ask `/mode status` only if nothing lands.
      // The delay keeps the normal path line-free, and the result is cached per
      // session so even the bridge costs one command line at most.
      React.useEffect(() => {
        if (projected !== null || fallback !== null || typeof read !== "function") return undefined;
        let cancelled = false;
        const timer = setTimeout(() => {
          Promise.resolve()
            .then(() => read())
            .then((text) => {
              if (!cancelled && typeof text === "string") setFallback(parseMode(text));
            })
            .catch((reason) => {
              if (!cancelled) setError(describe(reason));
            });
        }, 1200);
        return () => {
          cancelled = true;
          clearTimeout(timer);
        };
      }, [projected, fallback]);

      // The click's own settlement text outranks the projection: a stale
      // client-side projection snapshot used to pin the chip on 短考 forever
      // while the host happily switched. The projection still supplies the
      // first value, and once it agrees it is indistinguishable.
      const mode = fallback ?? projected ?? SHORT;

      const onClick = () => {
        const now = Date.now();
        if (busy || now - lastClickAt.current < 400) return;
        lastClickAt.current = now;
        const previous = mode;
        const next = previous === LONG ? SHORT : LONG;
        setBusy(true);
        setError(null);
        // Flip at once so the control never looks dead, then trust the host.
        setFallback(next);
        Promise.resolve()
          .then(() => toggle())
          .then((text) => {
            setBusy(false);
            if (typeof text === "string") setFallback(parseMode(text));
            else {
              setFallback(previous);
              setError("命令没返回结果（/mode 可能没注册）");
            }
          })
          .catch((reason) => {
            setBusy(false);
            setFallback(previous);
            setError(describe(reason));
          });
      };

      const isLong = mode === LONG;
      const title = isLong
        ? "长考：我自主推进，做完再汇报；需要你拍板就写下来停住（点一下切回短考）"
        : "短考：需要你决定时我会直接问（点一下切到长考）";

      return h(
        "span",
        { style: { display: "inline-flex", alignItems: "center", gap: "6px", minWidth: 0 } },
        h(
          "button",
          {
            type: "button",
            onClick,
            disabled: busy,
            title,
            "aria-label": title,
            "aria-pressed": isLong,
            "data-shortlong-mode": mode,
            style: buttonStyle(isLong, busy),
          },
          h("span", { style: dotStyle(isLong), "aria-hidden": true }),
          isLong ? "长考" : "短考",
        ),
        error === null
          ? null
          : h(
              "span",
              {
                role: "status",
                title: error,
                style: {
                  fontSize: "11px",
                  lineHeight: "16px",
                  color: "#e5484d",
                  maxWidth: "160px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                },
              },
              error,
            ),
      );
    }

    return {
      inject: ["slots", "remote", "remote.commands"],
      apply(ctx) {
        ctx.slots.inject("conversation.input.right", () =>
          ctx.slots.register(
            {
              name: "conversation.input.right",
              id: "shortlong-mode",
              order: 10,
              inject: (sessionId) => {
                // `remote.commands.execute` resolves `{ ok, value: { result: { kind, text } }, error }`;
                // `value === undefined` means the host does not know the command.
                const run = async (line) => {
                  if (sessionId === undefined) throw new Error("这个位置还没有会话 id");
                  const result = await ctx.remote.commands.execute(sessionId, line, []);
                  if (result?.ok !== true) throw new Error(result?.error?.message ?? "命令被拒绝");
                  if (result.value === undefined) throw new Error(`host 不认识 ${line}（插件可能没激活）`);
                  const text = result.value.result?.text;
                  if (typeof text !== "string") throw new Error("命令返回体里没有 text");
                  return text;
                };
                return {
                  // Bridge only: no projection ⇒ one cached status read per session.
                  read: () => {
                    if (commandedMode.has(sessionId)) return Promise.resolve(commandedMode.get(sessionId));
                    return run("/mode status").then((text) => {
                      commandedMode.set(sessionId, text);
                      return text;
                    });
                  },
                  // The remembered answer, parsed. Seeds the chip on remount so a
                  // session switch never falls back to 短考 while the projection
                  // is absent or stale.
                  getCached: () => {
                    const text = commandedMode.get(sessionId);
                    return typeof text === "string" ? parseMode(text) : null;
                  },
                  toggle: () => run("/mode").then((text) => {
                    commandedMode.set(sessionId, text);
                    return text;
                  }),
                };
              },
            },
            ModeChip,
          ),
        );
      },
    };
  },
});
