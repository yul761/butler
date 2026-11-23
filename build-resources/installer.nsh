; BTL-260：产品从 Butler 改名为 Shipherd，appId 从 io.statecore.butler 变成 io.statecore.shipherd。
; electron-builder 用 appId 算卸载注册表项的 GUID（UUID v5，命名空间 50e065bc-3134-11e6-9bab-38c9862bdaf3），
; 所以 Windows 把 Shipherd 当成另一个程序，装 Shipherd 不会顺带卸掉旧的 Butler。
; 这里在安装开始时查旧 Butler 的卸载项，找到就提示用户先卸载。这段必须认得旧名字，不能改名；
; 下面的 GUID 由 src/main/packaging.test.ts 校验确实是 UUID v5("io.statecore.butler")。
; TODO(5.0)：保留一个大版本后删掉。

!define LEGACY_BUTLER_GUID "21859fd2-9038-56c4-b2d5-aa0f0ba0fa21"
!define LEGACY_BUTLER_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${LEGACY_BUTLER_GUID}"
!define LEGACY_BUTLER_INSTALL_KEY "Software\${LEGACY_BUTLER_GUID}"
; 用户选过「不卸载」就记在这里，以后安装、更新 Shipherd 不再问（提权重新运行的那一次也不会再问一遍）。
!define LEGACY_BUTLER_DECLINED_KEY "Software\Shipherd"
!define LEGACY_BUTLER_DECLINED_VALUE "LegacyButlerPromptDeclined"

!macro customInit
  Push $0
  Push $1
  ReadRegStr $0 HKCU "${LEGACY_BUTLER_DECLINED_KEY}" "${LEGACY_BUTLER_DECLINED_VALUE}"
  StrCmp $0 "1" legacyButlerDone
  ; 旧 Butler 按用户安装（perMachine: false），卸载项在 HKCU；改过配置装到全机的，再看 HKLM。
  ReadRegStr $0 HKCU "${LEGACY_BUTLER_UNINSTALL_KEY}" "UninstallString"
  ReadRegStr $1 HKCU "${LEGACY_BUTLER_INSTALL_KEY}" "InstallLocation"
  StrCmp $0 "" 0 legacyButlerFound
  ReadRegStr $0 HKLM "${LEGACY_BUTLER_UNINSTALL_KEY}" "UninstallString"
  ReadRegStr $1 HKLM "${LEGACY_BUTLER_INSTALL_KEY}" "InstallLocation"
  StrCmp $0 "" legacyButlerDone legacyButlerFound

  legacyButlerFound:
  ; 静默安装（/S）不替用户卸载。
  MessageBox MB_YESNO|MB_ICONQUESTION "检测到旧版 Butler（Shipherd 改名前的名字）。$\r$\n$\r$\n建议现在卸载它：两个都装着会有两个开始菜单项，旧版再启动也看不到已经迁移到 Shipherd 的数据。卸载不会删除你的数据（~/.butler 和设置），Shipherd 第一次启动时会自动迁移。$\r$\n$\r$\n现在卸载旧版 Butler？$\r$\n$\r$\nAn older Butler (Shipherd's former name) is installed. We recommend uninstalling it now: with both installed you get two Start menu entries, and the old app will not see the data Shipherd has migrated. Uninstalling keeps your data (~/.butler and settings); Shipherd migrates it on first launch.$\r$\n$\r$\nUninstall the old Butler now?" /SD IDNO IDNO legacyButlerDeclined
  StrCmp $1 "" legacyButlerNoDir
  ; _?= 让卸载程序就地运行，ExecWait 才会等它卸完再继续安装。卸载程序自己留在原目录，卸完再删掉。
  ExecWait '$0 _?=$1'
  Delete "$1\Uninstall Butler.exe"
  RMDir "$1"
  Goto legacyButlerDone
  legacyButlerNoDir:
  ; 没有安装目录时只能直接运行卸载程序：它会把自己复制到临时目录再跑，ExecWait 等不到它卸完，安装照常继续。
  ExecWait '$0'
  Goto legacyButlerDone

  legacyButlerDeclined:
  ; 静默安装（/S）走的是默认的 IDNO，不算用户选过。
  IfSilent legacyButlerDone
  WriteRegStr HKCU "${LEGACY_BUTLER_DECLINED_KEY}" "${LEGACY_BUTLER_DECLINED_VALUE}" "1"

  legacyButlerDone:
  Pop $1
  Pop $0
!macroend
