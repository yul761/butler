import type { SecretBox } from "../notify/secret-box";

export type FakeSecretBox = SecretBox & { setAvailable(v: boolean): void; setBroken(v: boolean): void };

/** 只给测试用：可逆的假加密（逐字节异或），用来证明落盘的不是明文；可以模拟“加密不可用”和“解不开”。 */
export function fakeSecretBox(o: { available?: boolean; broken?: boolean } = {}): FakeSecretBox {
  let available = o.available ?? true;
  let broken = o.broken ?? false;
  const xor = (b: Uint8Array) => b.map((x) => x ^ 0x5a);
  return {
    available: () => available,
    encrypt: (plain) => xor(new TextEncoder().encode(plain)),
    decrypt: (data) => {
      if (broken) throw new Error("decrypt failed");
      return new TextDecoder().decode(xor(data));
    },
    setAvailable: (v) => {
      available = v;
    },
    setBroken: (v) => {
      broken = v;
    },
  };
}
