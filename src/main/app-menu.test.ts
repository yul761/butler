import { describe, expect, it } from "vitest";
import { appMenuTemplate } from "./app-menu";
import { setLang } from "./i18n";

describe("appMenuTemplate", () => {
  it("keeps Electron's standard menus and ends with Shipherd's Help items", () => {
    setLang("en");
    const click = () => undefined;
    const mac = appMenuTemplate({ platform: "darwin", help: [{ label: "Check for Updates…", click }] });
    expect(mac.map((m) => m.role)).toEqual(["appMenu", "fileMenu", "editMenu", "viewMenu", "windowMenu", "help"]);
    const help = mac.at(-1)!;
    expect(help.label).toBe("Help");
    expect(help.submenu).toEqual([{ label: "Check for Updates…", click }]);
    expect(appMenuTemplate({ platform: "win32", help: [] }).map((m) => m.role)).toEqual(["fileMenu", "editMenu", "viewMenu", "windowMenu", "help"]);
  });

  it("names Help in the current language", () => {
    setLang("zh");
    expect(appMenuTemplate({ platform: "win32", help: [] }).at(-1)!.label).toBe("帮助");
    setLang("en");
  });
});
