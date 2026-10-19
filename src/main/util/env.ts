type Env = Record<string, string | undefined>;

/** Windows 的环境变量名不区分大小写，通常是 "Path"。 */
export function pathKey(env: Env): string {
  return Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
}

export function withPath<T extends Env>(env: T, value: string): T {
  return { ...env, [pathKey(env)]: value };
}
