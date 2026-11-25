/**
 * Host half of the 短考 / 长考 bundle.
 *
 * Session-scoped working mode:
 *   - `short` (default): the user is present, ask when a decision is needed.
 *   - `long`: the user left; decide alone, report once, never block on them.
 *
 * Three responsibilities:
 *   1. A per-request prompt section whose text follows the session mode.
 *   2. The `/mode` slash command that switches it (also the log marker).
 *   3. In `long`, deny `ask_user_question` for that agent so the model cannot
 *      present a multiple-choice card the absent user will never answer.
 *
 * The mode is **derived from the session log**, not from plugin memory: the
 * `shortlong` projection folds the `/mode` command settlement into
 * `{ mode }`. Consequences, all intentional:
 *   - the Web UI reads the current mode from that projection, so opening a
 *     session no longer executes `/mode status` and no longer leaves a
 *     `>_ mode · 短考` line behind (only a real switch does);
 *   - the mode survives a host restart, a page reload, resume, and fork
 *     (historically it fell back to `short` after a host restart);
 *   - `command/done` text is the single source of truth, so the visible
 *     marker and the effective policy can never disagree.
 *
 * The `/mode` command stays the only writer; everything else only reads.
 */

export const inject = ["systemPrompt", "sessionProjections"];

const SHORT = "short";
const LONG = "long";

/** Prefix of every mode-switch settlement (`→ 短考` / `→ 长考`). */
const SWITCH_ARROW = "→";

const SHORT_TEXT = [
  "【当前模式：短考】用户就在旁边，随时能答话。",
  "- 需要用户拍板的事：一次问完。有提问工具就用它给选项并标出推荐项；没有就直接用文字问一句，别绕。",
  "- 能直接动手就直接动手，不先讲方案。不要建 todo、不要写 plan。",
  "- 只有当并行确实明显更快时才派子 agent；否则自己做完。",
  "- 交付先给结论，再给 2–3 行必要依据；不写过程流水账。",
  "- 预计要干 20 分钟以上：先用一句话说要多久，然后继续干，不等用户。",
].join("\n");

const LONG_TEXT = [
  "【当前模式：长考】用户已经离开，可能几小时不回来，不会及时回答你。按“做完再一次性汇报”工作。",
  "- 不要弹选择题、不要用提问卡片。真需要用户拍板时，用普通文字把卡点写清楚，结束当前回合。",
  "- 缺信息就按最合理的假设继续，不要停下来等人。把你替用户做的每个决定记下来。",
  "- 允许长时间探索、试错、并行派子 agent 验证；可以读任何需要的材料。",
  "- 改动工作区里的插件或配置前先备份、保证可回滚；不要动 DSH 安装目录本体、凭据文件、其他项目的用户数据。",
  "- 禁止对外不可逆操作：发布、上传、发消息、推送到远端。遇到就停下写清楚“我做到哪、想做什么、需要你按哪个按钮”。",
  "- 删除可以，但必须先备份；没有备份的东西不删。",
  "- 交付分三段：结论 / 我试了什么与证据 / 我替你假设了什么（标出最可疑、最容易推翻的那条）。",
].join("\n");

const TOOL_DENIED_IN_LONG = "ask_user_question";

/**
 * Boundary schema for `{ mode }`, hand-written on purpose.
 *
 * 本插件以 junction 装进 profile，真实路径在 `Documents/deepseek-harness/短考长考`，
 * 从那里解析不到 profile 的 `zod`；而 projection 运行时只调用 `parse`（持久化缓存播种
 * 与 wire 校验各一次），所以一个只有 `parse` 的对象就够了，不必引入依赖。
 */
const modeStateSchema = {
  parse(value) {
    const mode = (typeof value === "object" && value !== null) ? value.mode : undefined;
    if (mode !== SHORT && mode !== LONG) {
      throw new Error('shortlong: invalid state, expected { mode: "short" | "long" }');
    }
    return { mode };
  },
};

/**
 * Read the mode a settled `/mode` execution leaves behind.
 *
 * Only switch settlements carry the arrow prefix; `/mode status` answers with a
 * bare label and unknown arguments answer with an error, so neither can move
 * the state. Keeping this discriminator in one place is what lets the UI read
 * the mode without logging a query.
 *
 * @param text Verbatim `command/done` text.
 * @returns The switched-to mode, or undefined for any unrelated settlement.
 */
const switchedMode = (text) => {
  if (typeof text !== "string" || !text.trimStart().startsWith(SWITCH_ARROW)) return undefined;
  if (text.includes("长考")) return LONG;
  if (text.includes("短考")) return SHORT;
  return undefined;
};

/**
 * The `shortlong` session projection: `{ mode }` folded from the log.
 * Exported for tests and for readers that want the unit without the service.
 */
export const shortlongProjection = {
  key: "shortlong",
  stateVersion: 1,
  stateSchema: modeStateSchema,
  init: () => ({ mode: SHORT }),
  apply: (state, event) => {
    // A unit uninterested in an event MUST return the same reference.
    if (event.type !== "command/done") return state;
    const mode = switchedMode(event.data?.text);
    if (mode === undefined || mode === state.mode) return state;
    return { mode };
  },
  wire: {
    viewSchema: modeStateSchema,
    // The state object is replaced only when the mode changes, so the live
    // drive's `Object.is` compare publishes exactly the switches.
    view: state => state,
    // Keep the key out of Session summaries (the list row). A summary carries
    // a zero-I/O view of the persisted checkpoint, which can lag the live log
    // by a whole turn; once that cached row lands in the client's projection
    // store, reopening a Session without a fresh baseline renders the stale
    // value. The mode belongs to the connected Session only.
    summary: false,
  },
};

/**
 * Host half: prompt section, `/mode` command, per-agent tool restriction.
 *
 * Registration is awaited: the prompt section reads the projection synchronously,
 * and prompt assembly must never see a half-registered unit.
 *
 * @param ctx Cordis context of this plugin row.
 */
export async function apply(ctx) {
  const projection = await ctx.sessionProjections.register(shortlongProjection);

  /** Current mode of one session, folding any log tail the projection has not seen yet. */
  const modeOf = (session) => {
    const state = projection.stateOf(session);
    return state?.mode === LONG ? LONG : SHORT;
  };

  // 1. Prompt section, evaluated per request; the other mode contributes no text.
  ctx.systemPrompt.section({
    name: "shortlong:policy",
    order: 500,
    text: (context) => {
      const agent = context.agent;
      if (agent === undefined) return "";
      return modeOf(agent.session) === LONG ? LONG_TEXT : SHORT_TEXT;
    },
  });

  /**
   * Deny the question tool while the session reads long, and lift the
   * restriction when it reads short. Failure is logged, not fatal: the prompt
   * contract still holds.
   */
  const restrictions = new WeakMap();
  const disposers = new Set();

  const release = (session) => {
    const dispose = restrictions.get(session);
    if (dispose === undefined) return;
    restrictions.delete(session);
    disposers.delete(dispose);
    try {
      dispose();
    } catch (error) {
      ctx.logger?.warn?.("shortlong-mode: could not lift the tool restriction: %o", error);
    }
  };

  const syncTools = (agent) => {
    const session = agent.session;
    const tools = agent.ctx?.tools;
    if (tools === undefined || typeof tools.restrict !== "function") return;
    if (modeOf(session) !== LONG) {
      release(session);
      return;
    }
    if (restrictions.has(session)) return;
    try {
      const dispose = tools.restrict({ deny: [TOOL_DENIED_IN_LONG] });
      restrictions.set(session, dispose);
      disposers.add(dispose);
    } catch (error) {
      ctx.logger?.warn?.("shortlong-mode: could not deny %s: %o", TOOL_DENIED_IN_LONG, error);
    }
  };

  // The mode outlives the process now, so a resumed Session can enter its next
  // step already in long mode without any command having run in this process.
  // Reconcile here: every step, before its request is assembled.
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    const agent = payload?.agent;
    if (agent !== undefined) syncTools(agent);
    return decision;
  });

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {}
    }
    disposers.clear();
  }, "shortlong-mode: lift tool restrictions");

  const label = (mode) => (mode === LONG ? "长考" : "短考");

  // 2. `/mode [short|long|status]` — bare form toggles. The settlement text is
  //    the projection's only input, so it is also the user-visible marker.
  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: "@todrink/dsh-shortlong",
      name: "mode",
      description: "切换短考 / 长考（不传参数则切换）",
      input: { hint: "[short|long|status]" },
      handler: ({ agent, rawInput }) => {
        if (agent === undefined) return { kind: "error", text: "这个命令需要一个会话。" };
        const current = modeOf(agent.session);
        const arg = rawInput.trim().toLowerCase();
        if (arg === "status" || arg === "状态") return { kind: "success", text: label(current) };
        if (arg === "short" || arg === "短" || arg === "短考") return { kind: "success", text: `${SWITCH_ARROW} ${label(SHORT)}` };
        if (arg === "long" || arg === "长" || arg === "长考") return { kind: "success", text: `${SWITCH_ARROW} ${label(LONG)}` };
        if (arg !== "") return { kind: "error", text: `不认识的参数 “${arg}”；用 /mode、/mode short、/mode long、/mode status。` };
        return { kind: "success", text: `${SWITCH_ARROW} ${label(current === LONG ? SHORT : LONG)}` };
      },
    });
  });
}
