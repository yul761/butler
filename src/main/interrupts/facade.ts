import type { InterruptsAction, InterruptsActResult, InterruptsState, ProfileScan } from "../../shared/interrupts";
import type { NotificationLogRepo } from "../db/interrupts-repo";
import type { Notifier } from "../notify/notifier";
import type { WebhookStore } from "../notify/webhook-store";
import type { PermissionProfileService } from "../permissions/profile-service";
import type { ChoiceService } from "./choices";

const LIST_MAX = 200;
const RULE_MAX = 500;
const URL_MAX = 2000;

export interface InterruptsFacadeDeps {
  profiles: Pick<PermissionProfileService, "rules" | "state" | "scan" | "explain" | "decide" | "remove">;
  choices: Pick<ChoiceService, "list" | "unreviewed" | "review" | "defaults" | "saveDefault" | "deleteDefault">;
  webhook: Pick<WebhookStore, "state" | "save" | "clear">;
  notifier: Pick<Notifier, "test">;
  log: Pick<NotificationLogRepo, "recent">;
}

/** 设置页「打断与通知」和向导「权限档案」这一步的 IPC 门面（ws-j）。 */
export class InterruptsFacade {
  constructor(private readonly d: InterruptsFacadeDeps) {}

  state(): InterruptsState {
    return {
      profiles: this.d.profiles.rules(), autoChoices: this.d.choices.list(), unreviewed: this.d.choices.unreviewed(), defaults: this.d.choices.defaults(),
      webhook: this.d.webhook.state(), log: this.d.log.recent(50),
    };
  }

  profiles(): ProfileScan {
    return this.d.profiles.state();
  }

  async scan(explain: boolean): Promise<ProfileScan> {
    await this.d.profiles.scan();
    return explain ? this.d.profiles.explain() : this.d.profiles.state();
  }

  async act(a: InterruptsAction): Promise<InterruptsActResult> {
    let test: InterruptsActResult["test"];
    switch (a.op) {
      case "profile_decide":
        this.d.profiles.decide(a.slug, a.confirm, a.dismiss);
        break;
      case "profile_remove":
        this.d.profiles.remove(a.slug, a.rule);
        break;
      case "choices_review":
        this.d.choices.review(a.ids);
        break;
      case "default_save":
        this.d.choices.saveDefault(a);
        break;
      case "default_delete":
        this.d.choices.deleteDefault(a.id);
        break;
      case "webhook_save":
        this.d.webhook.save(a.url);
        break;
      case "webhook_clear":
        this.d.webhook.clear();
        break;
      case "notify_test":
        test = await this.d.notifier.test();
        break;
    }
    return test ? { state: this.state(), test } : { state: this.state() };
  }
}

const str = (v: unknown, max: number): string => {
  if (typeof v !== "string" || v.length > max) throw new Error("invalid interrupts action");
  return v;
};
const strList = (v: unknown): string[] => {
  if (!Array.isArray(v) || v.length > LIST_MAX) throw new Error("invalid interrupts action");
  return v.map((x) => str(x, RULE_MAX));
};
const id = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new Error("invalid interrupts action");
  return v;
};

/** IPC 参数检查（规则本身的安全检查在 PermissionProfileService.decide 里）。 */
export function interruptsActionArg(v: unknown): InterruptsAction {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("invalid interrupts action");
  switch (o.op) {
    case "profile_decide":
      return { op: "profile_decide", slug: str(o.slug, 201), confirm: strList(o.confirm), dismiss: strList(o.dismiss) };
    case "profile_remove":
      return { op: "profile_remove", slug: str(o.slug, 201), rule: str(o.rule, RULE_MAX) };
    case "choices_review":
      if (o.ids === null) return { op: "choices_review", ids: null };
      if (!Array.isArray(o.ids) || o.ids.length > LIST_MAX) throw new Error("invalid interrupts action");
      return { op: "choices_review", ids: o.ids.map(id) };
    case "default_save":
      if (typeof o.enabled !== "boolean") throw new Error("invalid interrupts action");
      return { op: "default_save", id: o.id === null ? null : id(o.id), pattern: str(o.pattern, 1000), answer: str(o.answer, 2000), enabled: o.enabled };
    case "default_delete":
      return { op: "default_delete", id: id(o.id) };
    case "webhook_save":
      return { op: "webhook_save", url: str(o.url, URL_MAX) };
    case "webhook_clear":
    case "notify_test":
      return { op: o.op };
    default:
      throw new Error("invalid interrupts action");
  }
}
