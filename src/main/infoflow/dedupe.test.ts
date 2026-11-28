import { describe, expect, it } from "vitest";
import { DUP_SIMILARITY, findDuplicate, normalizeFact, polarityClash, similarity, stem } from "./dedupe";

describe("normalizeFact", () => {
  it("drops a source note whose session name has brackets", () => {
    expect(normalizeFact("BTL-12 不做了（来自 S(t12) 的对话）")).toBe(normalizeFact("BTL-12 不做了"));
    expect(normalizeFact("Use pagination (from Fix (2)'s conversation)")).toBe("usepagination");
  });

  it("drops punctuation, spaces, case and a trailing source note", () => {
    expect(normalizeFact("BTL-12 不做了，需求变了。（来自 epic 4 总控的对话）")).toBe("btl12不做了需求变了");
    expect(normalizeFact("API returns pages (from BTL-3's conversation)")).toBe("apireturnspages");
  });
});

describe("similarity", () => {
  it("is 1 for the same fact written differently and low for different facts", () => {
    expect(similarity("BTL-12 不做了，需求变了", "btl 12 不做了 —— 需求变了！")).toBe(1);
    expect(similarity("以后接口一律分页返回", "导出按钮放到右上角")).toBeLessThan(0.2);
    expect(similarity("", "x")).toBe(0);
  });
});

describe("findDuplicate", () => {
  const memory = ["[ticket:BTL-3] 登录接口改成返回 token 和 refreshToken 两个字段", "以后 PR 一律先跑 e2e 再开", "BTL-12 不做了"];

  it("finds a near-identical fact", () => {
    expect(findDuplicate("登录接口改成返回 token 和 refreshToken 两个字段。", memory)).toBe(memory[0]);
    expect(findDuplicate("以后PR一律先跑e2e再开！", memory)).toBe(memory[1]);
  });

  it("finds a fact contained in a longer one, but not a short substring", () => {
    expect(findDuplicate("登录接口改成返回 token 和 refreshToken", memory)).toBe(memory[0]);
    // 「BTL-12 不做了」只有 8 个字：太短，包含关系不算；整句相似度也不够。
    expect(findDuplicate("BTL-12 不做了，因为客户换了需求，PR #41 也要关掉", memory)).toBeNull();
  });

  it("finds an exact repeat of a short fact", () => {
    expect(findDuplicate("BTL-12 不做了", ["BTL-12 不做了"])).toBe("BTL-12 不做了");
    expect(findDuplicate("btl-12：不做了。", memory)).toBe(memory[2]);
    expect(findDuplicate("BTL-12 不做了", ["BTL-12 不做了（来自 S(t12) 的对话）"])).toBe("BTL-12 不做了（来自 S(t12) 的对话）");
  });

  it("lets a newer fact through when it says more than an older one it contains", () => {
    const old = ["接口 /users 一律分页返回"];
    expect(findDuplicate("接口 /users 一律分页返回，每页最多 100 条", old)).toBeNull();
    expect(findDuplicate("接口 /users 一律分页返回", ["接口 /users 一律分页返回，每页最多 100 条"])).toBe("接口 /users 一律分页返回，每页最多 100 条");
  });

  it("never merges facts about different numbers", () => {
    const old = ["BTL-12 改成先做，客户下周要先看登录这一块"];
    expect(findDuplicate("BTL-13 改成先做，客户下周要先看登录这一块", old)).toBeNull();
    expect(findDuplicate("btl 12 改成先做：客户下周要先看登录这一块", old)).toBe(old[0]);
  });

  it("keeps a different fact", () => {
    expect(findDuplicate("导出按钮放到右上角", memory)).toBeNull();
    expect(findDuplicate("   ", memory)).toBeNull();
  });

  it("uses the documented threshold", () => {
    expect(DUP_SIMILARITY).toBeGreaterThan(0.5);
  });
});

// BTL-280 实测（specs/4.3.0/shared-brain-design.md L3）：改主意的两句字面很像，Dice ≥ 0.8，以前被当成重复吞掉。
describe("findDuplicate keeps a change of mind (BTL-280 L3)", () => {
  const CHANGED: [string, string][] = [
    ["BTL-280 不等 #109 合了再开始实现", "BTL-280 等 #109 合了再开始实现"],
    ["release must not ask the user first", "release must ask the user first"],
    ["Windows 安装包默认关闭自动更新", "Windows 安装包默认开启自动更新"],
  ];

  it.each(CHANGED)("%s / %s: similar enough to pass the threshold, but not a duplicate either way", (a, b) => {
    // 证明是去重规则本身在拦：光看 Dice 这两句就算重复。
    expect(similarity(a, b)).toBeGreaterThanOrEqual(DUP_SIMILARITY);
    expect(findDuplicate(a, [b])).toBeNull();
    expect(findDuplicate(b, [a])).toBeNull();
    expect(polarityClash(a, b)).toBe(true);
  });

  it("still finds a true duplicate that differs only in punctuation or a filler word", () => {
    expect(findDuplicate("Windows 安装包默认关闭自动更新啦。", ["Windows 安装包默认关闭自动更新"])).toBe("Windows 安装包默认关闭自动更新");
    expect(findDuplicate("BTL-280 不等 #109 合了，再开始实现吧", ["BTL-280 不等 #109 合了再开始实现"])).toBe("BTL-280 不等 #109 合了再开始实现");
    expect(findDuplicate("Release must NOT ask the user first!", ["release must not ask the user first"])).toBe("release must not ask the user first");
    expect(polarityClash("Windows 安装包默认关闭自动更新啦。", "Windows 安装包默认关闭自动更新")).toBe(false);
    // 语气词只在去重里去掉：normalizeFact（actions 找原话用的）照旧。
    expect(normalizeFact("再开始实现吧")).toBe("再开始实现吧");
  });

  it("does not let a contained sentence through when the older one says the opposite", () => {
    // 新的整条在旧的里（包含规则），但旧的多了个「不」：是改主意，不是重复。
    expect(findDuplicate("要等 #109 合了再开始实现 BTL-280", ["不要等 #109 合了再开始实现 BTL-280"])).toBeNull();
    expect(findDuplicate("默认开启 Windows 安装包的自动更新", ["默认开启 Windows 安装包的自动更新以后允许用户关闭"])).toBe("默认开启 Windows 安装包的自动更新以后允许用户关闭");
  });

  it("counts every listed negation word, Chinese and English", () => {
    for (const neg of ["不", "没", "别", "无", "非", "未", "勿"]) expect(polarityClash(`这个 PR ${neg}合并到 main 分支上`, "这个 PR 合并到 main 分支上")).toBe(true);
    for (const [a, b] of [
      ["release does not ask the user first", "release does ask the user first"],
      ["release should never ask the user first", "release should ask the user first"],
      ["release shouldn't ask the user first", "release should ask the user first"],
      ["release shouldn’t ask the user first", "release should ask the user first"],
      ["release goes out with no user check first", "release goes out with a user check first"],
      ["release goes out without asking the user first", "release goes out asking the user first"],
      ["release cannot ask the user first", "release can ask the user first"],
    ]) {
      expect([a, b, polarityClash(a, b)]).toEqual([a, b, true]);
      expect(findDuplicate(a, [b])).toBeNull();
    }
    // 个数一样、词不一样：「没合并」（没做）和「不合并」（不做）是两回事。
    expect(polarityClash("这个 PR 没合并到 main 分支上", "这个 PR 不合并到 main 分支上")).toBe(true);
    // 英文按整词：know 里的 no、notify 里的 not 不算，只有一边有也不算。
    expect(polarityClash("know the answer before the release", "see the answer before the release")).toBe(false);
    expect(polarityClash("notify the reviewer first", "ping the reviewer first")).toBe(false);
    // cannot 和 can not 是同一个否定：不算改主意。
    expect(polarityClash("release cannot ask the user first", "release can not ask the user first")).toBe(false);
    // 词里带着的不算：notify、another、know、nothing 不是否定词。
    expect(polarityClash("notify another reviewer first", "notify another reviewer first please")).toBe(false);
  });

  it("counts an antonym on one side and its opposite on the other", () => {
    const PAIRS: [string, string][] = [
      ["开启", "关闭"], ["打开", "关掉"], ["打开", "关闭"], ["启用", "停用"], ["启用", "禁用"], ["允许", "禁止"],
      ["enable", "disable"], ["enabled", "disabled"], ["on", "off"], ["allow", "deny"], ["show", "hide"], ["include", "exclude"],
    ];
    for (const [x, y] of PAIRS) {
      const a = `the windows installer keeps auto update ${x} by default`;
      const b = `the windows installer keeps auto update ${y} by default`;
      expect([x, y, polarityClash(a, b), polarityClash(b, a)]).toEqual([x, y, true, true]);
      expect(findDuplicate(a, [b])).toBeNull();
    }
    // 两句都两个都有：看先后，换了顺序就是改主意。
    expect(polarityClash("先关闭旧的开关再开启新的开关", "先开启旧的开关再关闭新的开关")).toBe(true);
    expect(findDuplicate("先关闭旧的开关再开启新的开关", ["先开启旧的开关再关闭新的开关"])).toBeNull();
    expect(polarityClash("先关闭旧的开关再开启新的开关", "先关闭旧的开关，再开启新的开关")).toBe(false);
    // 一句两个都有、另一句只有一个：不算，交给包含和相似度。
    expect(polarityClash("默认开启", "默认开启，允许用户关闭")).toBe(false);
    // 两边都是同一个词：照常比较。
    expect(polarityClash("自动更新默认开启", "自动更新默认开启。")).toBe(false);
    // 英文按整词：button 里的 on、shower 里的 show 不算。
    expect(polarityClash("move the button to the top right corner", "move the button to the top right")).toBe(false);
    expect(polarityClash("show the shower", "hide the shower")).toBe(true);
    expect(polarityClash("the shower stays", "the shower hides")).toBe(false);
  });
});

describe("findDuplicate, opus review of bd556adf (BTL-272)", () => {
  // 必须修 1：同一个否定的几种写法、常见复合词里的「非」「未」：还是重复，不再发一遍。
  it.each([
    ["We don't merge on Fridays.", "We do not merge on Fridays."],
    ["Deploys can't run before the 9am freeze ends.", "Deploys cannot run before the 9am freeze ends."],
    ["The bot won't retry failed webhook deliveries.", "The bot will not retry failed webhook deliveries."],
    ["Never commit .env files", "Do not ever commit .env files"],
    ["别在周五下午往生产环境发版", "不要在周五下午往生产环境发版"],
    ["勿在周五下午往生产环境发版", "不在周五下午往生产环境发版"],
    ["这个改动不用等 alice review 了", "这个改动不等 alice review 了"],
    ["发版不用等 CI", "发版不要等 CI"],
    ["We won't merge", "We will not merge"],
    ["未来所有新包都统一用 pnpm 管理依赖", "以后所有新包都统一用 pnpm 管理依赖"],
    ["这个接口非常重要，必须先做分页", "这个接口很重要，必须先做分页"],
    ["所有接口无论内外都要加鉴权", "所有接口不管内外都要加鉴权"],
    ["别人提的 PR 也要跑一遍 e2e", "其他人提的 PR 也要跑一遍 e2e"],
  ])("same meaning, negation spelled differently: %s ~ %s", (a, b) => {
    expect(findDuplicate(a, [b])).toBe(b);
    expect(findDuplicate(b, [a])).toBe(a);
  });

  it("keeps 不同意 and 不过关 as negations (not the 不同 / 不过 compounds)", () => {
    expect(findDuplicate("我不同意这个发版方案的回滚步骤", ["我同意这个发版方案的回滚步骤"])).toBeNull();
    expect(findDuplicate("这次的性能测试不过关，要重跑", ["这次的性能测试过关，要重跑"])).toBeNull();
    // 不同、不过 本身不是否定：「两个仓库的分支名不同」和「两个仓库的分支名不一样」不因为否定词对不上就算新的。
    expect(polarityClash("两个仓库用的分支名不同，记得区分", "两个仓库用的分支名有差异，记得区分")).toBe(false);
  });

  // 必须修 2：writeNote 存的「<note> #2」变体，注记里的 session 名带否定词。
  it.each([
    ["接口要分页，每页最多 100 条", "接口要分页，每页最多 100 条（来自 修复不能登录 的对话） #2"],
    ["List endpoints are paginated, at most 100 per page", "List endpoints are paginated, at most 100 per page (from fix-no-cache's conversation) #2"],
    ["List endpoints are paginated, at most 100 per page", "List endpoints are paginated, at most 100 per page (from don't-retry's conversation) #12"],
  ])("matches a memory note with the ' #N' variant suffix: %s ~ %s", (a, b) => {
    expect(findDuplicate(a, [b])).toBe(b);
    expect(normalizeFact(b)).toBe(normalizeFact(a));
  });

  it("keeps a trailing #N that is not after a source note: PR #2 and PR #3 are different facts", () => {
    expect(normalizeFact("先合并 PR #2")).toBe("先合并pr2");
    expect(findDuplicate("先合并 PR #3", ["先合并 PR #2"])).toBeNull();
  });

  // 必须修 3：改主意的词只在一边出现：不是重复，包含规则也不能吞掉。
  it.each([
    ["每周五下午三点准时发版到生产环境", "取消每周五下午三点准时发版到生产环境"],
    ["每天凌晨自动同步上游仓库的定时任务", "停止每天凌晨自动同步上游仓库的定时任务"],
    ["夜间构建的自动重试功能先停掉", "夜间构建的自动重试功能先开着"],
    ["每天凌晨自动同步上游仓库的定时任务", "暂停每天凌晨自动同步上游仓库的定时任务"],
    ["每天凌晨自动同步上游仓库的定时任务", "撤销每天凌晨自动同步上游仓库的定时任务"],
    ["每天凌晨自动同步上游仓库的定时任务", "每天凌晨自动同步上游仓库的定时任务去掉"],
    ["每周五下午三点准时发版到生产环境", "改成每周五下午三点准时发版到生产环境"],
    ["每周五下午三点准时发版到生产环境", "改为每周五下午三点准时发版到生产环境"],
    ["Release every Friday at 3pm to production", "Cancel the release every Friday at 3pm to production"],
    ["The nightly mirror job syncs the upstream repo", "Stop the nightly mirror job that syncs the upstream repo"],
    ["The nightly mirror job syncs the upstream repo", "The nightly mirror job syncs the upstream repo, paused for now"],
    ["The nightly mirror job syncs the upstream repo", "Reverted: the nightly mirror job syncs the upstream repo"],
    ["Release is blocked on the security review", "Release is no longer blocked on the security review"],
    ["Release every Friday at 3pm to production", "Cancelled the release every Friday at 3pm to production"],
  ])("a change of mind is new either way: %s vs %s", (a, b) => {
    expect(findDuplicate(a, [b])).toBeNull();
    expect(findDuplicate(b, [a])).toBeNull();
  });

  // 建议 a、b：补的反义词，按词干比；w 对 un+w、dis+w。
  it.each([
    ["Keep the legacy export endpoint for now", "Drop the legacy export endpoint for now"],
    ["Keep the legacy export endpoint", "Remove the legacy export endpoint"],
    ["We will stop using the old staging cluster", "We will keep using the old staging cluster"],
    ["Pause the nightly deploy job", "Resume the nightly deploy job"],
    ["The setting enables auto-merge for all repos", "The setting disables auto-merge for all repos"],
    ["Retries are increased to five", "Retries are decreased to five"],
    ["Uploads are allowed for guest users", "Uploads are disallowed for guest users"],
    ["The repo is locked for the release", "The repo is unlocked for the release"],
    ["The bot keeps old branches around", "The bot removes old branches around"],
  ])("antonyms by stem and un- / dis- prefixes: %s vs %s", (a, b) => {
    expect(polarityClash(a, b)).toBe(true);
    expect(findDuplicate(a, [b])).toBeNull();
  });

  it("stems common inflections the same way", () => {
    for (const [w, s] of [["enable", "enabl"], ["enabled", "enabl"], ["enables", "enabl"], ["deny", "deny"], ["denied", "deny"], ["denies", "deny"],
      ["stopped", "stop"], ["stopping", "stop"], ["added", "add"], ["add", "add"], ["closes", "clos"], ["this", "this"], ["class", "class"], ["status", "status"]]) {
      expect(stem(w), w).toBe(s);
    }
  });

  // 建议 c：拉丁词、数字一样，顺序对调了。
  it.each([
    ["Use pnpm, not npm, for this repo", "Use npm, not pnpm, for this repo"],
    ["用 pnpm 不用 npm 管理这个仓库的依赖", "用 npm 不用 pnpm 管理这个仓库的依赖"],
    ["先做 BTL-12 再做 BTL-13", "先做 BTL-13 再做 BTL-12"],
    ["Migrate from MySQL to Postgres", "Migrate from Postgres to MySQL"],
    ["Ship the staging build first, then production", "Ship the production build first, then staging"],
  ])("A and B swapped is not a duplicate: %s vs %s", (a, b) => {
    expect(findDuplicate(a, [b])).toBeNull();
  });

  // 建议 d：单位变了。
  it.each([
    ["Rate limit is 100 requests per minute", "Rate limit is 100 requests per second"],
    ["接口限流是每分钟 100 次请求", "接口限流是每秒 100 次请求"],
    ["Uploads are capped at 10 MB per file", "Uploads are capped at 10 GB per file"],
    ["Cache entries expire after 30m", "Cache entries expire after 30s"],
    ["日志保留 30 天，到期自动清理", "日志保留 30 周，到期自动清理"],
  ])("a different unit is not a duplicate: %s vs %s", (a, b) => {
    expect(findDuplicate(a, [b])).toBeNull();
  });

  it("still finds a duplicate with the same unit, or a unit only on one side", () => {
    expect(findDuplicate("Rate limit is 100 requests per minute.", ["Rate limit is 100 requests per minute"])).not.toBeNull();
    expect(findDuplicate("接口限流是每分钟 100 次请求。", ["接口限流是每分钟 100 次请求"])).not.toBeNull();
    expect(polarityClash("the timeout is 30 for every endpoint", "the timeout is 30 seconds for every endpoint")).toBe(false);
  });

  // 建议 e：有意的取舍。只是换了说法、动作的先后跟着换了，被当成新的：多发一次比吞掉一个改主意强（根治放 BTL-280 第 4 步）。
  it.each([
    ["Close the old PR and open a new one for the fix", "Open a new PR for the fix and close the old one"],
    ["Run lint before tests, after install", "After install, run lint before tests"],
    ["先关闭旧的开关再开启新的开关", "开启新的开关之前先关闭旧的开关"],
  ])("intended trade-off: a reworded sentence whose actions swap order counts as new: %s vs %s", (a, b) => {
    expect(findDuplicate(a, [b])).toBeNull();
  });

  // 变异测试漏网的（P14、P15）：语气词只在分句末尾去掉；keep / drop 这一对。
  it("strips a filler particle only at the end of a clause, not inside a word", () => {
    // 词中间的「呢」「啦」「吧」不是语气词：去掉的话两句就一字不差了。
    expect(findDuplicate("呢子大衣和啦啦队的吧台", ["子大衣和队的台"])).toBeNull();
    expect(findDuplicate("子大衣和队的台", ["呢子大衣和啦啦队的吧台"])).toBeNull();
    expect(findDuplicate("先开始实现吧", ["先开始实现"])).toBe("先开始实现");
  });

  it("tells 'without' apart from 'not': shipping without a review is not 'not shipping with a review'", () => {
    expect(polarityClash("release ships without a manual review step", "release doesn't ship with a manual review step")).toBe(true);
    expect(polarityClash("release ships without a manual review step", "release ships without any manual review step")).toBe(false);
  });

  it("counts keep and drop as opposites", () => {
    expect(polarityClash("keep the cache", "drop the cache")).toBe(true);
    expect(polarityClash("drop the cache", "keep the cache")).toBe(true);
  });
});

describe("review of fed50a04 (dedupe)", () => {
  it.each([
    // 否定被当成复合词去掉
    ["这个配置同步到生产环境", "这个配置不同步到生产环境"],
    ["e2e 和 lint 同时跑", "e2e 和 lint 不同时跑"],
    ["每页少于 100 条记录", "每页不少于 100 条记录"],
    ["登录 token 过期以后要重新登录", "登录 token 不过期以后要重新登录"],
    // 句子本身以「(from …)」结尾
    ["Switch the default branch (from master to main)", "Switch the default branch (from main to master)"],
    // no longer：另一边也有否定词时只靠改主意词
    ["Don't wait for CI; reviews are required", "Don't wait for CI; reviews are no longer required"],
    // 不再：另一边也有「不」
    ["不用等 CI，发版需要 alice review", "不用等 CI，发版不再需要 alice review"],
    // 反义词各占一边、两边都有时看先后（stop/keep、start/stop、pause/resume、停掉/开着）
    ["Stop the old cluster and keep the new one", "Keep the old cluster, stop the new one"],
    ["Start the old job and stop the new one", "Stop the old job, start the new one"],
    ["Pause the old job and resume the new one", "Resume the old job, pause the new one"],
    ["旧的重试先停掉，新的重试先开着", "旧的重试先开着，新的重试先停掉"],
    // 改回、升降级、上下线
    ["升级 node 到 22", "降级 node 到 22"],
    ["上线新版本的支付页", "下线新版本的支付页"],
    ["Move the button to the left side of the toolbar", "Move the button to the right side of the toolbar"],
    ["Releasing every Friday at 3pm to production", "Releasing every Friday at 3pm to production is dropped"],
  ])("does not merge %s / %s", (a, b) => {
    expect(findDuplicate(a, [b])).toBeNull();
    expect(findDuplicate(b, [a])).toBeNull();
  });

  it("does not let a switch back match the older fact it returns to", () => {
    expect(findDuplicate("这个仓库改回用 npm 管理依赖", ["这个仓库用 npm 管理依赖", "这个仓库改成用 pnpm 管理依赖"])).toBeNull();
  });

  it.each([
    ["CI can't run e2e", "CI cannot run the e2e"],
    ["You shan't skip lint", "You shall not skip the lint"],
    ["It ain't ready yet", "It is not ready yet"],
    ["The Friday release is cancelled until March", "The Friday release is canceled until March"],
    ["这个接口特别重要，必须先做分页", "这个接口很重要，必须先做分页"],
    ["两个仓库用的分支名不同，记得区分", "两个仓库用的分支名不同，要记得区分"],
  ])("still merges %s / %s", (a, b) => {
    expect(findDuplicate(a, [b])).toBe(b);
    expect(findDuplicate(b, [a])).toBe(a);
  });
});

describe("review of fed50a04, coordinator decisions (dedupe)", () => {
  it.each([
    // 中文句子里的拉丁词按数字比：一边换成了别的词。
    ["这个仓库用 npm 管理依赖", "这个仓库用 pnpm 管理依赖"],
    ["默认分支是 main，PR 都开到这里", "默认分支是 master，PR 都开到这里"],
    ["单测用 vitest 跑，不要用别的", "单测用 jest 跑，不要用别的"],
    ["主进程的包打成 ESM 格式发布", "主进程的包打成 CJS 格式发布"],
    // 限定词只在一边：多出来的部分加了条件、例外或期限。
    ["这个接口在周五发版", "这个接口只在周五发版"],
    ["这个接口在周五发版", "这个接口仅在周五发版"],
    ["每个 PR 都要跑完整的 e2e", "除了文档 PR，每个 PR 都要跑完整的 e2e"],
    ["每个 PR 都要跑完整的 e2e", "每个 PR 都要跑完整的 e2e，除非是热修复"],
    ["BTL-280 的数据迁移这周开始做", "BTL-280 的数据迁移先缓，这周开始做"],
    ["新的巡检逻辑默认打开", "新的巡检逻辑暂时默认打开"],
    ["新的巡检逻辑默认打开", "新的巡检逻辑暂停默认打开"],
    ["Run the full e2e suite on every pull request", "Run the full e2e suite on every pull request only"],
    ["Run the full e2e suite on every pull request", "Run the full e2e suite on every pull request except docs"],
    ["Run the full e2e suite on every pull request", "Run the full e2e suite on every pull request unless it is a hotfix"],
    ["Run the full e2e suite on every pull request", "Run the full e2e suite on every pull request until March"],
    ["Run the full e2e suite on every pull request", "Run the full e2e suite on every pull request for now"],
  ])("does not merge %s / %s", (a, b) => {
    expect(findDuplicate(a, [b])).toBeNull();
    expect(findDuplicate(b, [a])).toBeNull();
  });

  it.each([
    // 拉丁词一样、只差标点或语气词：照样是重复。
    ["这个仓库用 pnpm 管理依赖", "这个仓库用pnpm管理依赖吧"],
    // 两边都有同一个限定词；「只是」「只要」不算限定词。
    ["这个接口只在周五发版", "这个接口只在周五发版吧"],
    ["这个改动只是重命名，不用跑 e2e", "这个改动是重命名，不用跑 e2e"],
    ["Run the full e2e suite only on release branches", "Run the full e2e suite only on the release branches"],
  ])("still merges %s / %s", (a, b) => {
    expect(findDuplicate(a, [b])).toBe(b);
    expect(findDuplicate(b, [a])).toBe(a);
  });

  it("does not count a Latin word only one side has (like a ticket prefix), and 只要 is not a qualifier", () => {
    // 新的被旧的包含才算重复：短的那句找得到长的那句。
    expect(findDuplicate("这个仓库用 pnpm 管理依赖", ["BTL-280 这个仓库用 pnpm 管理依赖"])).toBe("BTL-280 这个仓库用 pnpm 管理依赖");
    expect(findDuplicate("CI 绿了就可以直接合并到主干", ["只要 CI 绿了就可以直接合并到主干"])).toBe("只要 CI 绿了就可以直接合并到主干");
  });

  it("treats went back and go back as the same change of mind", () => {
    expect(findDuplicate("We went back to npm for this repo", ["We go back to npm for this repo"])).not.toBeNull();
  });

  it("compares English words only when both sentences are Chinese: a Chinese source note does not make an English fact Chinese", () => {
    // 英文句子换一个词留给 BTL-280：这里照旧靠相似度。
    expect(findDuplicate("Use pnpm to manage the dependencies of this repo", ["Use pnpm to manage the dependency of this repo"])).not.toBeNull();
    expect(findDuplicate("Use pnpm to manage the dependencies of this repo（来自 S1 的对话）", ["Use pnpm to manage the dependency of this repo"])).not.toBeNull();
    expect(findDuplicate("Use pnpm to manage the dependencies of this repo（来自 S1 的对话）", ["Use npm to manage the dependencies of this repo（来自 S2 的对话）"])).not.toBeNull();
  });

  it.each(["取消", "停止", "停掉", "暂停", "撤销", "不再", "改成", "改为", "去掉", "改回", "换回", "切回", "恢复", "回滚", "作废", "撤回", "废弃", "作罢"])(
    "counts %s as a change of mind",
    (w) => {
      const a = "每周五下午的发版流程照常进行";
      expect(findDuplicate(a, [`${w}${a}`])).toBeNull();
      expect(findDuplicate(`${w}${a}`, [a])).toBeNull();
    },
  );

  it.each([
    "cancel", "cancelled", "stop", "stopped", "pause", "paused", "revert", "reverted", "no longer", "undo", "undone", "roll back", "rolled back",
    "rollback", "switch back", "switched back", "go back", "went back", "call off", "called off", "scrap", "scrapped", "abandon", "abandoned",
    "restore", "restored", "drop", "dropped", "halt", "halted", "on hold", "deprecate", "deprecated",
  ])("counts %s as a change of mind", (w) => {
    const a = "release the desktop app to production every friday at three";
    expect(findDuplicate(a, [`${w} ${a}`])).toBeNull();
    expect(findDuplicate(`${w} ${a}`, [a])).toBeNull();
  });

  it.each([
    // 分句开头的「不过」是转折，句中的「不过滤」「不过期」是否定。
    ["日志过滤敏感词以后再上传", "日志不过滤敏感词以后再上传"],
    ["过期的缓存每天凌晨清理一次", "不过期的缓存每天凌晨清理一次"],
    ["过夜的任务第二天早上重跑一遍", "不过夜的任务第二天早上重跑一遍"],
  ])("keeps a mid-word or clause-start 不过 that is a negation: %s / %s", (a, b) => {
    expect(findDuplicate(a, [b])).toBeNull();
    expect(findDuplicate(b, [a])).toBeNull();
  });

  it("still drops a clause-start 不过 (but) before counting negations", () => {
    expect(findDuplicate("先合 #109，不过 CI 要先绿", ["先合 #109，CI 要先绿"])).not.toBeNull();
  });
});
