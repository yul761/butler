export function signMacApp(input: {
  appPath: string;
  env: Record<string, string | undefined>;
  identity?: unknown;
  exec: (cmd: string, args: string[], opts: { stdio: "inherit" }) => unknown;
}): "builder" | "ad-hoc";
