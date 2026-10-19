import * as pty from "node-pty";
import type { PtyFactory } from "./pty-manager";

export const nodePtyFactory: PtyFactory = (file, args, opts) => {
  const p = pty.spawn(file, args, { name: "xterm-256color", cwd: opts.cwd, env: opts.env, cols: opts.cols, rows: opts.rows });
  return {
    get pid() {
      return p.pid;
    },
    onData: (cb) => {
      p.onData(cb);
    },
    onExit: (cb) => {
      p.onExit(({ exitCode }) => cb({ exitCode }));
    },
    write: (d) => p.write(d),
    resize: (c, r) => p.resize(c, r),
    kill: () => p.kill(),
  };
};
