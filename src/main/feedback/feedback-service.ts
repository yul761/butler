// 「发送反馈」（BTL-254）：拼出预填好的 new issue 链接交给系统浏览器；附诊断时先给用户看脱敏后的内容，确认了再存进下载目录。
// Shipherd 自己不往外发任何东西：issue 由用户在 GitHub 上点提交，诊断文件由用户自己拖进去。
import { join } from "node:path";
import type { DiagnosticsFile } from "../diag/diag-export";
import { redactedDiagnostics, type RedactTerms } from "../diag/redact";
import { feedbackUrl, type FeedbackEnv, type FeedbackKind } from "../../shared/feedback";

export interface FeedbackOpenRequest {
  kind: FeedbackKind;
  title: string;
  description: string;
  step?: string;
  /** 链接里提一句刚存下的诊断文件。 */
  attachDiagnostics: boolean;
}

export interface FeedbackOpenResult {
  url: string;
  /** 链接放不下全文，截过；全文已复制到剪贴板。 */
  truncated: boolean;
}

export interface FeedbackSaveResult {
  path: string;
  name: string;
}

export interface FeedbackServiceDeps {
  env: () => FeedbackEnv;
  openExternal: (url: string) => Promise<void>;
  copyText: (text: string) => void;
  buildDiagnostics: () => Promise<DiagnosticsFile>;
  redactTerms: () => RedactTerms;
  downloadsDir: () => string;
  exists: (path: string) => boolean;
  writeFile: (path: string, text: string) => Promise<void>;
  showItemInFolder: (path: string) => void;
  now: () => number;
  log: (msg: string, e?: unknown) => void;
}

export class FeedbackService {
  /** 最近一次给用户看过的脱敏诊断：存的就是这一份，渲染进程不传内容。 */
  private preview: string | null = null;
  private saved: FeedbackSaveResult | null = null;

  constructor(private readonly d: FeedbackServiceDeps) {}

  async open(r: FeedbackOpenRequest): Promise<FeedbackOpenResult> {
    const link = feedbackUrl(
      { kind: r.kind, title: r.title, description: r.description, step: r.step, diagnosticsFile: r.attachDiagnostics ? this.saved?.name ?? null : null },
      this.d.env(),
    );
    if (link.truncated) {
      const full = [r.title.trim(), r.description.trim()].filter(Boolean).join("\n\n");
      try {
        this.d.copyText(full);
      } catch (e) {
        this.d.log("feedback: copying the full text failed", e);
      }
    }
    await this.d.openExternal(link.url);
    this.d.log(`feedback: opened a ${r.kind} issue page${link.truncated ? " (text truncated)" : ""}`);
    return link;
  }

  /** 导出一份诊断并脱敏，返回要给用户看的全文。 */
  async previewDiagnostics(): Promise<string> {
    const file = redactedDiagnostics(await this.d.buildDiagnostics(), this.d.redactTerms());
    this.preview = `${JSON.stringify(file, null, 2)}\n`;
    return this.preview;
  }

  /** 把刚给用户看过的那份存进下载目录（重名加 -1、-2…），在 Finder / 资源管理器里选中。 */
  async saveDiagnostics(): Promise<FeedbackSaveResult> {
    if (this.preview === null) throw new Error("no diagnostics preview to save");
    const dir = this.d.downloadsDir();
    const stamp = new Date(this.d.now()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const base = `shipherd-diagnostics-redacted-${stamp}`;
    let name = `${base}.json`;
    for (let i = 1; this.d.exists(join(dir, name)); i++) name = `${base}-${i}.json`;
    const path = join(dir, name);
    await this.d.writeFile(path, this.preview);
    this.preview = null;
    this.saved = { path, name };
    try {
      this.d.showItemInFolder(path);
    } catch (e) {
      this.d.log("feedback: showing the diagnostics file failed", e);
    }
    this.d.log("feedback: redacted diagnostics saved to the Downloads folder");
    return this.saved;
  }
}

const OS_NAMES: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** 系统名加版本（process.getSystemVersion()，例如 macOS 15.1.0、Windows 10.0.22631）。 */
export function osName(platform: string, systemVersion: string | null): string {
  const name = OS_NAMES[platform] ?? platform;
  return systemVersion ? `${name} ${systemVersion}` : name;
}
