import { describe, expect, it } from "vitest";
import { hasSecret, maskSecrets, SECRET_MASK } from "./secrets";

/** 拼出来的假密钥（不在源码里写成一整段，免得被扫描器当成真的）。 */
const fake = {
  ghp: "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  pat: "github_pat_" + "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
  sk: "sk-" + "proj-AbCdEf0123456789GhIjKl",
  ant: "sk-ant-" + "api03-AbCdEf0123456789",
  akia: "AKIA" + "IOSFODNN7EXAMPLE",
  slack: "xoxb-" + "1234567890-abcdefghij",
  hex: "0123456789abcdef".repeat(3),
  b64: "dGhpcyBpcyBhIHNlY3JldCBrZXkgZm9yIHRlc3Rpbmc5" + "Q",
  jwt: "eyJ" + "hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcDEF123456",
  glpat: "glpat-" + "AbCdEf0123456789xyzQ",
  npm: "npm_" + "AbCdEf0123456789GhIjKlMnOpQrStUvWx",
  whsec: "whsec_" + "AbCdEf0123456789GhIj",
  skLive: "sk_live_" + "AbCdEf0123456789GhIj",
  rkLive: "rk_live_" + "AbCdEf0123456789GhIj",
  skTest: "sk_test_" + "AbCdEf0123456789GhIj",
};

describe("maskSecrets (BTL-272: no secrets in memory, mail or the DB)", () => {
  it.each(Object.entries(fake))("masks %s and leaves none of it", (_name, secret) => {
    const out = maskSecrets(`部署用 ${secret} 这个`);
    expect(out).toBe(`部署用 ${SECRET_MASK} 这个`);
    expect(hasSecret(`x ${secret}`)).toBe(true);
  });

  it("masks Bearer tokens and key = value passwords, keeping the key", () => {
    expect(maskSecrets("Authorization: Bearer abc.def-ghi_123456")).toBe(`Authorization: ${SECRET_MASK}`);
    expect(maskSecrets("测试库密码是 hunter2xyz，记一下")).toBe(`测试库密码是 ${SECRET_MASK}，记一下`);
    expect(maskSecrets("api_key=s3cr3tvalue; then")).toBe(`api_key=${SECRET_MASK}; then`);
  });

  it("masks the password in URL credentials, keeping user and host", () => {
    expect(maskSecrets("连 postgres://admin:S3cretPass@db/app 就行")).toBe(`连 postgres://admin:${SECRET_MASK}@db/app 就行`);
    expect(maskSecrets("git clone https://user:pw@host/repo.git")).toBe(`git clone https://user:${SECRET_MASK}@host/repo.git`);
    expect(maskSecrets("https://github.com/o/r/pull/41")).toBe("https://github.com/o/r/pull/41");
  });

  it("masks English 'the password is …' when the value has a digit or symbol, and leaves prose alone", () => {
    expect(maskSecrets("the password is hunter2xyz ok")).toBe(`the password is ${SECRET_MASK} ok`);
    expect(maskSecrets("The API key is abcd-efgh-ijkl")).toBe(`The API key is ${SECRET_MASK}`);
    // 有意取舍：只有字母的值当成普通的话，不打码。
    expect(maskSecrets("the token is expired, log in again")).toBe("the token is expired, log in again");
  });

  it("masks JSON / YAML quoted keys and keeps the quotes", () => {
    expect(maskSecrets('{"api_key": "abcd1234efgh"}')).toBe(`{"api_key": "${SECRET_MASK}"}`);
    expect(maskSecrets('"token": "shortTok9",')).toBe(`"token": "${SECRET_MASK}",`);
    expect(maskSecrets("password: 'p4ssw0rd'")).toBe(`password: '${SECRET_MASK}'`);
  });

  it("masks key names joined with _ or -, and env-style *_KEY / *_TOKEN / *_SECRET / *_PASSWORD", () => {
    expect(maskSecrets("SECRET_KEY=abcd1234")).toBe(`SECRET_KEY=${SECRET_MASK}`);
    expect(maskSecrets("client-secret: zyxw9876")).toBe(`client-secret: ${SECRET_MASK}`);
    expect(maskSecrets("STRIPE_API_KEY=abcd1234 DB_PASSWORD=hunter22 GH_TOKEN=tok12345")).toBe(
      `STRIPE_API_KEY=${SECRET_MASK} DB_PASSWORD=${SECRET_MASK} GH_TOKEN=${SECRET_MASK}`,
    );
    // 小写的 primary_key 不是密钥。
    expect(maskSecrets("primary_key: user_id")).toBe("primary_key: user_id");
  });

  it("leaves 7–12 and 40 char hex commit SHAs alone, masks 13–39 and 41+ (intended: a 40-hex legacy token slips through)", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(sha).toHaveLength(40);
    expect(maskSecrets(`合到 ${sha} 了`)).toBe(`合到 ${sha} 了`);
    expect(maskSecrets(`合到 ${sha.slice(0, 7)} 了`)).toBe(`合到 ${sha.slice(0, 7)} 了`);
    expect(maskSecrets(`合到 ${sha.slice(0, 12)} 了`)).toBe(`合到 ${sha.slice(0, 12)} 了`);
    // 32 位 hex：Datadog / Twilio 的 key。13 位、39 位也打。
    for (const n of [13, 32, 39]) expect(maskSecrets(`k ${sha.slice(0, n)} x`), String(n)).toBe(`k ${SECRET_MASK} x`);
    // 41 位以上的 hex 仍然打码（SHA-256、API key）。
    expect(maskSecrets(`k ${sha}ab`)).toBe(`k ${SECRET_MASK}`);
    // 只有数字的不算（时间戳、电话）。
    expect(maskSecrets("at 1732700000000 ms")).toBe("at 1732700000000 ms");
  });

  it("leaves file paths alone unless one of their segments looks like a token", () => {
    const path = "src/renderer/src/components/LivePagesWrapperComponent.test.tsx";
    expect(maskSecrets(`改了 ${path}`)).toBe(`改了 ${path}`);
    // 有一段 24 位以上、大小写字母和数字都有：当成藏在路径里的 token。
    const hidden = `uploads/${"AbCdEf0123456789GhIjKlMn"}/report.pdf`;
    expect(maskSecrets(`见 ${hidden}`)).not.toContain("AbCdEf0123456789GhIjKlMn");
  });

  it("turns a whole private key block into one mask, with nothing of the block left, even with other secrets inside", () => {
    const block = `-----BEGIN RSA PRIVATE KEY----- MIIEowIBAAKCAQEA${fake.b64} ${fake.ghp} Bearer zzzzzzzzzzzz -----END RSA PRIVATE KEY-----`;
    const out = maskSecrets(`钥匙：${block} 完`);
    expect(out).toBe(`钥匙：${SECRET_MASK} 完`);
    expect(out.split(SECRET_MASK)).toHaveLength(2);
    for (const piece of ["BEGIN", "MIIE", "ghp_", "Bearer", "END"]) expect(out).not.toContain(piece);
  });

  it("is idempotent and leaves ordinary text alone: ticket keys, short SHAs, PR links, file paths, words", () => {
    const plain = "BTL-12 不做了；合到 572ddc2f；见 https://github.com/o/r/pull/41 和 src/main/infoflow/infoflow-service.test.ts；skip-the-flaky-test";
    expect(maskSecrets(plain)).toBe(plain);
    expect(hasSecret(plain)).toBe(false);
    const once = maskSecrets(`token: ${fake.ghp}`);
    expect(maskSecrets(once)).toBe(once);
  });

  it("masks URL credentials with an empty user or a %2F in the password; a bare / is a known gap", () => {
    expect(maskSecrets("连 redis://:p4ss@cache:6379 就行")).toBe(`连 redis://:${SECRET_MASK}@cache:6379 就行`);
    expect(maskSecrets("amqp://u:a%2Fb+c@mq/vhost")).toBe(`amqp://u:${SECRET_MASK}@mq/vhost`);
    // 有意取舍（文件头的已知漏打）：userinfo 里不该有裸 /，认了它很多个 :// 时就慢。
    expect(maskSecrets("amqp://u:a/b+c@mq/vhost")).toBe("amqp://u:a/b+c@mq/vhost");
  });

  it("masks a quoted value up to its closing quote, even several words or a short one", () => {
    expect(maskSecrets('password: "correct horse battery staple" ok')).toBe(`password: "${SECRET_MASK}" ok`);
    expect(maskSecrets("passphrase = 'ab cd'")).toBe(`passphrase = '${SECRET_MASK}'`);
    expect(maskSecrets('{"token": "ab"}')).toBe(`{"token": "${SECRET_MASK}"}`);
    expect(maskSecrets('DB_PASSWORD="two words"')).toBe(`DB_PASSWORD="${SECRET_MASK}"`);
    expect(maskSecrets('the password is "open sesame 1"')).toBe(`the password is "${SECRET_MASK}"`);
    // 引号里同时有 URL 凭据、token、邮箱：整段只剩一个占位符，原文一个字都不留。
    const inner = `redis://u:pw9@h ${fake.ghp} me@example.com Bearer abcdefgh1234`;
    const out = maskSecrets(`secret: "${inner}" done`);
    expect(out).toBe(`secret: "${SECRET_MASK}" done`);
    for (const piece of ["redis", "pw9", "ghp_", "example", "Bearer"]) expect(out).not.toContain(piece);
  });

  it("masks Basic auth and command-line passwords", () => {
    expect(maskSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toBe(`Authorization: ${SECRET_MASK}`);
    expect(maskSecrets("curl -u admin:hunter2 https://x")).toBe(`curl -u admin:${SECRET_MASK} https://x`);
    expect(maskSecrets("curl --user admin:hunter2 https://x")).toBe(`curl --user admin:${SECRET_MASK} https://x`);
    expect(maskSecrets("deploy --password hunter2 --token abcd1234")).toBe(`deploy --password ${SECRET_MASK} --token ${SECRET_MASK}`);
    expect(maskSecrets("mysql -uroot -phunter2 db")).toBe(`mysql -uroot -p${SECRET_MASK} db`);
    expect(maskSecrets("docker login -u me -p hunter2 ghcr.io")).toBe(`docker login -u me -p ${SECRET_MASK} ghcr.io`);
    // 端口不是密码；mkdir -p 后面隔着空格。
    expect(maskSecrets("ssh -p22 host; docker run -p8080:80 img; mkdir -p dir")).toBe("ssh -p22 host; docker run -p8080:80 img; mkdir -p dir");
  });

  it("masks .npmrc _auth, Cookie headers, passphrase, a bare key=, token followed by a long string, and 'password is: x'", () => {
    expect(maskSecrets("_auth=dXNlcjpwYXNz")).toBe(`_auth=${SECRET_MASK}`);
    expect(maskSecrets("//registry.npmjs.org/:_authToken=abcd1234")).toBe(`//registry.npmjs.org/:_authToken=${SECRET_MASK}`);
    expect(maskSecrets("Cookie: session=abc123; csrf=zz")).toBe(`Cookie: ${SECRET_MASK}`);
    expect(maskSecrets("passphrase: mylongphrase")).toBe(`passphrase: ${SECRET_MASK}`);
    expect(maskSecrets("key=abcd1234")).toBe(`key=${SECRET_MASK}`);
    expect(maskSecrets('{"key": "x9y8z7w6"}')).toBe(`{"key": "${SECRET_MASK}"}`);
    expect(maskSecrets("use token Ab12Cd34Ef56Gh78 for it")).toBe(`use token ${SECRET_MASK} for it`);
    expect(maskSecrets("the password is: x")).toBe(`the password is: ${SECRET_MASK}`);
    // primary_key、monkey 不是 key；「token is expired」照旧。
    expect(maskSecrets("primary_key: user_id; monkey=banana")).toBe("primary_key: user_id; monkey=banana");
  });

  it("masks a value whose opening quote never closes (cut off), the same as an unquoted one", () => {
    expect(maskSecrets('password: "hunter2xyz')).toBe(`password: "${SECRET_MASK}`);
    expect(maskSecrets('API_KEY="abc123unterminated')).toBe(`API_KEY="${SECRET_MASK}`);
    expect(maskSecrets('密码："abc123')).toBe(`密码："${SECRET_MASK}`);
    // 没闭合的引号打到行尾（后面带空格的话也打掉）。
    expect(maskSecrets("token: 'abc123 (truncated")).toBe(`token: '${SECRET_MASK}`);
    expect(maskSecrets('password: "hunter2xyz\nnext')).toBe(`password: "${SECRET_MASK}\nnext`);
    expect(maskSecrets('DB_PASSWORD="hunter2xyz')).toBe(`DB_PASSWORD="${SECRET_MASK}`);
    expect(maskSecrets('key="x9y8z7w6v5')).toBe(`key="${SECRET_MASK}`);
    // 闭合的照旧只打一次，不会二次打码。
    expect(maskSecrets('password: "hunter2xyz" ok')).toBe(`password: "${SECRET_MASK}" ok`);
  });

  it("leaves URL ports alone, but not a password that starts with a digit and has no /", () => {
    for (const url of ["http://localhost:5173/@vite/client", "ws://host:8080/path@v2", "http://127.0.0.1:3000/@fs/a.ts"]) {
      expect(maskSecrets(`开 ${url} 看`)).toBe(`开 ${url} 看`);
    }
    expect(maskSecrets("redis://:12345pw@cache")).toBe(`redis://:${SECRET_MASK}@cache`);
  });

  it("masks Basic only after Authorization: or when the value has a digit, =, + or /", () => {
    expect(maskSecrets("open Basic Settings and Basic Authentication docs")).toBe("open Basic Settings and Basic Authentication docs");
    expect(maskSecrets("authorization: basic dXNlcjpwYXNzd29yZA")).toBe(`authorization: ${SECRET_MASK}`);
    expect(maskSecrets("header basic dXNlcjpwYXNz3")).toBe(`header ${SECRET_MASK}`);
    expect(maskSecrets("sent Basic YWxhZGRpbjpvcGVuc2VzYW1l=")).toBe(`sent ${SECRET_MASK}`);
  });

  it("masks only the name=value; pairs of a Cookie header and keeps the rest of the sentence", () => {
    expect(maskSecrets("Cookie: session=abc123; then restart the server")).toBe(`Cookie: ${SECRET_MASK}; then restart the server`);
    expect(maskSecrets("Set-Cookie: sid=xyz; Path=/; HttpOnly 之后再看")).toBe(`Set-Cookie: ${SECRET_MASK}; HttpOnly 之后再看`);
  });

  it("only treats -p as a password after mysql, mysqldump, mariadb or mysqladmin, quoted values included", () => {
    expect(maskSecrets("mkdir -pv out && gcc -pthread a.c && tar -pxf x.tar")).toBe("mkdir -pv out && gcc -pthread a.c && tar -pxf x.tar");
    expect(maskSecrets("mysqldump -u root -p'S3cret pw' db > a.sql")).toBe(`mysqldump -u root -p${SECRET_MASK} db > a.sql`);
    expect(maskSecrets('mariadb -h db -p"Hunter 2" app')).toBe(`mariadb -h db -p${SECRET_MASK} app`);
    expect(maskSecrets("mysqladmin -uroot -phunter2 status")).toBe(`mysqladmin -uroot -p${SECRET_MASK} status`);
    // mysql -p 后面隔空格是「提示输入密码」，没有值。
    expect(maskSecrets("mysql -u root -p app")).toBe("mysql -u root -p app");
  });

  it("leaves a bare key alone when it is a ticket key, a {…} expression, a key name or a short value", () => {
    expect(maskSecrets("key=BTL-272 和 key: BTL-12")).toBe("key=BTL-272 和 key: BTL-12");
    expect(maskSecrets("<Row key={item.id} /> 和 key: \"Enter\"、key: 'ArrowDown'、key=\"a1\"")).toBe(
      "<Row key={item.id} /> 和 key: \"Enter\"、key: 'ArrowDown'、key=\"a1\"",
    );
    expect(maskSecrets("key=abcd1234")).toBe(`key=${SECRET_MASK}`);
    expect(maskSecrets('key: "my secret phrase"')).toBe(`key: "${SECRET_MASK}"`);
  });

  it("leaves 'the token is expired.' with a full stop alone and keeps GitHub commit / blob links whole", () => {
    expect(maskSecrets("the token is expired. log in again")).toBe("the token is expired. log in again");
    // ! ? 算符号：宁可误打（「password is Welcome!」要打掉），这句也就被打了。
    expect(maskSecrets("The password is wrong!")).toBe(`The password is ${SECRET_MASK}`);
    expect(maskSecrets("password is Welcome!")).toBe(`password is ${SECRET_MASK}`);
    expect(maskSecrets("我们的 token is valid。下一步")).toBe("我们的 token is valid。下一步");
    expect(maskSecrets("the password is hunter2xyz.")).toBe(`the password is ${SECRET_MASK}`);
    const sha = "510c0661c1b3d3d022c8803b8eaf4f87e703c685";
    for (const url of [
      `https://github.com/yul761/Shipherd/commit/${sha}`,
      `https://github.com/yul761/Shipherd/blob/${sha}/src/main/infoflow/Secrets2Handler`,
    ]) {
      expect(maskSecrets(`见 ${url} 。`)).toBe(`见 ${url} 。`);
    }
    // URL 里有一段像 token：照打。
    expect(maskSecrets(`https://hooks.example.com/services/${"AbCdEf0123456789GhIjKlMn"}/x`)).not.toContain("AbCdEf0123456789GhIjKlMn");
  });

  it("masks secrets in a URL query string, webhook paths and token-like URL path segments, but keeps GitHub links whole", () => {
    const code = "aB3+dE5fG7/hJ9kL1mN3pQ5rS7tU9vW/xY1zA=";
    expect(maskSecrets(`回调 https://app.example.com/cb?code=${code} 已收到`)).toBe(`回调 https://app.example.com/cb?code=${SECRET_MASK} 已收到`);
    const sig = "sv=2022-11-02&ss=b&sig=AbCdEf0123456789%2BGhIjKl%3D";
    const out = maskSecrets(`https://acct.blob.core.windows.net/c/f.txt?${sig}`);
    expect(out).toContain(`sig=${SECRET_MASK}`);
    expect(out).not.toContain("AbCdEf0123456789");
    expect(maskSecrets("https://api.example.com/Webhooks/a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6")).not.toContain("a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6");
    // Slack webhook 的秘密段没有数字，也要打掉。
    const slack = "https://hooks.slack.com/services/T0ABCDEFG/B0ABCDEFG/" + "abcdefghijklmnopQRSTUVWX";
    expect(maskSecrets(slack)).not.toContain("abcdefghijklmnopQRSTUVWX");
    // 路径段 16 位以上、字母数字都有（只缺一类字符）的也打。
    expect(maskSecrets("https://x.example.com/files/abcdefghij0123456789/Download")).not.toContain("abcdefghij0123456789");
    const sha = "510c0661c1b3d3d022c8803b8eaf4f87e703c685";
    expect(maskSecrets(`https://github.com/yul761/Shipherd/commit/${sha}`)).toBe(`https://github.com/yul761/Shipherd/commit/${sha}`);
  });

  it("masks JSON-style Basic auth, a Cookie value without name=, sshpass, unclosed mysql quotes and a far -p", () => {
    expect(maskSecrets('{"Authorization": "Basic dXNlcjpwYXNz"}')).toBe(`{"Authorization": "${SECRET_MASK}"}`);
    expect(maskSecrets("Authorization=Basic dXNlcjpwYXNz")).toBe(`Authorization=${SECRET_MASK}`);
    expect(maskSecrets("Cookie: abc123secretvalue then")).toBe(`Cookie: ${SECRET_MASK} then`);
    expect(maskSecrets("sshpass -p 'S3cret pw' ssh me@host")).toBe(`sshpass -p ${SECRET_MASK} ssh me@host`);
    expect(maskSecrets("sshpass -phunter2 ssh host")).toBe(`sshpass -p${SECRET_MASK} ssh host`);
    expect(maskSecrets("mysql -u root -p'S3cret")).toBe(`mysql -u root -p${SECRET_MASK}`);
    const far = `mysql ${"--opt ".repeat(150)}-phunter2 db`;
    expect(far.indexOf("-phunter2")).toBeGreaterThan(800);
    expect(maskSecrets(far)).not.toContain("hunter2");
    // 不在同一条命令里（隔着 ; 或 |）的 -p 不算。
    expect(maskSecrets("mysql -e 'select 1'; mkdir -pv out")).toBe("mysql -e 'select 1'; mkdir -pv out");
  });

  it("masks backtick-quoted values and an unclosed quote after 'is'", () => {
    expect(maskSecrets("password: `hunter2xyz`")).toBe(`password: \`${SECRET_MASK}\``);
    expect(maskSecrets("API_KEY=`hunter2xyz`")).toBe(`API_KEY=\`${SECRET_MASK}\``);
    expect(maskSecrets("password: `hunter2xyz")).toBe(`password: \`${SECRET_MASK}`);
    expect(maskSecrets('token is "abc123def')).toBe(`token is "${SECRET_MASK}`);
    expect(maskSecrets("the password is: 'abc123def")).toBe(`the password is: '${SECRET_MASK}`);
  });

  it("keeps quoted ; | & inside one command and starts a new command after a long first one", () => {
    expect(maskSecrets("mysql -uroot -p'Xy7;k&9!' db")).toBe(`mysql -uroot -p${SECRET_MASK} db`);
    expect(maskSecrets('mysql -p"ab|cd" db')).toBe(`mysql -p${SECRET_MASK} db`);
    expect(maskSecrets("docker login -p 'ab;cd12345' reg.example.com")).toBe(`docker login -p ${SECRET_MASK} reg.example.com`);
    expect(maskSecrets("docker login -p 'two words' reg")).toBe(`docker login -p ${SECRET_MASK} reg`);
    expect(maskSecrets("sshpass -p 'S3c&ret' ssh me@host")).toBe(`sshpass -p ${SECRET_MASK} ssh me@host`);
    const second = "mysql " + "x ".repeat(495) + "mysql --opt -phunter2 db";
    expect(maskSecrets(second)).not.toContain("hunter2");
    const farOnly = "mysql " + "x ".repeat(2000) + "-phunter2 db";
    expect(maskSecrets(farOnly)).not.toContain("hunter2");
  });

  it("masks values after backtick-quoted key names", () => {
    expect(maskSecrets("- `DB_PASSWORD`: `hunter2xyz`")).toBe(`- \`DB_PASSWORD\`: \`${SECRET_MASK}\``);
    expect(maskSecrets("- `DB_PASSWORD`: hunter2xyz")).toBe(`- \`DB_PASSWORD\`: ${SECRET_MASK}`);
    expect(maskSecrets("`token`: hunter2xyz")).toBe(`\`token\`: ${SECRET_MASK}`);
    expect(maskSecrets("`key`: `abcd1234efgh`")).toBe(`\`key\`: \`${SECRET_MASK}\``);
    expect(maskSecrets("`key`: abcd1234efgh")).toBe(`\`key\`: ${SECRET_MASK}`);
    // 键名不在 KEY_NAMES 里的环境变量键、带空格的引号值：只有对应的那条规则打得掉。
    expect(maskSecrets("`DEPLOY_PASS`: `two words`")).toBe(`\`DEPLOY_PASS\`: \`${SECRET_MASK}\``);
    expect(maskSecrets("`DEPLOY_PASS`: hunter2xyz")).toBe(`\`DEPLOY_PASS\`: ${SECRET_MASK}`);
    expect(maskSecrets("`key`: `abcd 1234efgh`")).toBe(`\`key\`: \`${SECRET_MASK}\``);
  });

  /** 每段都不到 16 位、单看都不像 token 的长串：只有在 URL 路径里才放过，所以能看出「是不是在 URL 路径里」判得对不对。 */
  const plainSegs = "Abcdefghijklmn1/Abcdefghijklmn2/Abcdefghijklmn3";

  it("only treats a long string as part of a URL path when nothing but path separates it from ://", () => {
    expect(maskSecrets(`https://x.example.com/a/${plainSegs}`)).toBe(`https://x.example.com/a/${plainSegs}`);
    // 查询串、片段里的不算。
    for (const lead of ["?", "#", "?a=1&", "?state=", "&", ";state="]) {
      expect(maskSecrets(`https://x.example.com/p${lead}${plainSegs}`), lead).toBe(`https://x.example.com/p${lead}${SECRET_MASK}`);
    }
    // 任何空白都把 URL 断开：全角空格、NBSP、\v、\f、U+2028。
    for (const ws of ["\u3000", "\u00a0", "\v", "\f", "\u2028", "\t"]) {
      expect(maskSecrets(`https://x.example.com/a${ws}${plainSegs}`), JSON.stringify(ws)).toBe(`https://x.example.com/a${ws}${SECRET_MASK}`);
    }
    // 引号、尖括号、反引号、逗号、中文标点也把 URL 断开。
    expect(maskSecrets(`{"url":"https://x.example.com/a","v":"${plainSegs}"}`)).toBe(`{"url":"https://x.example.com/a","v":"${SECRET_MASK}"}`);
    expect(maskSecrets(`链接https://x.example.com/a，凭证${plainSegs}`)).toBe(`链接https://x.example.com/a，凭证${SECRET_MASK}`);
    expect(maskSecrets(`see https://x.example.com/a,${plainSegs}`)).toBe(`see https://x.example.com/a,${SECRET_MASK}`);
    for (const p of ['"', "'", "`", "<", ">", ",", "，", "。", "、", "；", "：", "！", "？"]) {
      expect(maskSecrets(`https://x.example.com/a${p}${plainSegs}`), p).toBe(`https://x.example.com/a${p}${SECRET_MASK}`);
    }
    // 离 :// 超过 256 个字的不算。
    const far = `https://x.example.com/${"a.".repeat(200)}/${plainSegs}`;
    expect(maskSecrets(far)).not.toContain(plainSegs);
    const near = `https://x.example.com/${"a.".repeat(100)}/${plainSegs}`;
    expect(maskSecrets(near)).toBe(near);
  });

  it("masks only the token-like segments of a URL path, so the link is still recognisable", () => {
    // 工单号开头的分支名、slug 段留着（只在 URL 路径里）。
    const branch = "https://github.com/yul761/Shipherd/tree/feature/BTL-272-secret-masking";
    expect(maskSecrets(branch)).toBe(branch);
    // 不带协议的照旧打（宁可误打）；slug 里有一小段像 token 的也打。
    expect(maskSecrets("github.com/yul761/Shipherd/tree/feature/BTL-272-secret-masking")).not.toContain("BTL-272-secret-masking");
    const hidden = "a1b2c3d4e5f6g7h8i9j0k1";
    expect(maskSecrets(`https://x.example.com/tree/BTL-1-${hidden}`)).toBe(`https://x.example.com/tree/${SECRET_MASK}`);
    expect(maskSecrets(`https://x.example.com/tree/BTL-1-${hidden}-two/Docs`)).not.toContain(hidden);
    expect(maskSecrets("https://linear.app/acme/issue/BTL-272/fix-oauth2-callback-for-v3")).toBe(`https://linear.app/acme/issue/BTL-272/${SECRET_MASK}`);
    expect(maskSecrets("https://api.example.com/v1/Users/550e8400-e29b-41d4-a716-446655440000/Profile")).toBe(
      `https://api.example.com/v1/Users/${SECRET_MASK}/Profile`,
    );
    const tok = "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW";
    expect(maskSecrets(`见 https://files.example.com/Share/${tok}/Report 。`)).toBe(`见 https://files.example.com/Share/${SECRET_MASK}/Report 。`);
  });

  it("masks query values, Slack and Discord webhook paths with their own rules", () => {
    // 这些值只有字母，base64 / hex 规则兜不住：只有专门的规则能打掉。
    expect(maskSecrets("https://app.example.com/cb?code=abcdefghijklmnop")).toBe(`https://app.example.com/cb?code=${SECRET_MASK}`);
    expect(maskSecrets("https://app.example.com/cb?x=1&sig=abcdefghijklmnop&y=2")).toBe(`https://app.example.com/cb?x=1&sig=${SECRET_MASK}&y=2`);
    expect(maskSecrets("https://hooks.slack.com/services/T0/B0/abcdefghijklmnopqrstuvwx")).toBe(`https://hooks.slack.com/services/${SECRET_MASK}`);
    expect(maskSecrets("https://discord.com/api/webhooks/1/abcdefghijklmnopqrstuvwxyz")).toBe(`https://discord.com/api/webhooks/${SECRET_MASK}`);
    // 值不设长度上限；后面的反引号、括号留着。
    expect(maskSecrets("?code=" + "a".repeat(5000) + " end")).toBe(`?code=${SECRET_MASK} end`);
    expect(maskSecrets("fetch(`/x?key=${tok}`)")).toBe(`fetch(\`/x?key=${SECRET_MASK}\`)`);
    expect(maskSecrets("(see https://x.com/cb?code=abcdefgh)")).toBe(`(see https://x.com/cb?code=${SECRET_MASK})`);
  });

  it("masks a whole standard base64 string (+ or =) inside a URL path, not just its long segments", () => {
    const out = maskSecrets("下载 https://x.com/dl/aB3+dE5fG7/hJ9kL1mN3pQ5rS7tU9vW/xY1zA2 吧");
    for (const piece of ["aB3", "dE5fG7", "hJ9kL1", "xY1zA2"]) expect(out).not.toContain(piece);
    expect(out).toBe(`下载 https://x.${SECRET_MASK} 吧`);
    expect(maskSecrets("https://x.com/dl/aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vWxY1zA2==")).not.toContain("aB3");
  });

  it("masks the rest of a -p value whose quote pairs up wrong, and honours \\\" escapes", () => {
    expect(maskSecrets("mysql's flag: mysql -uroot -p'Xy7;k&9!' db")).toBe(`mysql's flag: mysql -uroot -p${SECRET_MASK} db`);
    expect(maskSecrets('mysql -p"a\\"b;c" db')).toBe(`mysql -p${SECRET_MASK} db`);
    // 转义的引号不把命令里的引号配错：后面的 mkdir -pv 还是另一条命令。
    expect(maskSecrets('mysql -p"a\\"b" x; mkdir -pv y')).toBe(`mysql -p${SECRET_MASK} x; mkdir -pv y`);
    // 往后打的那段里，转义的引号也不算闭引号。
    expect(maskSecrets('mysql "x -p"ab;c\\"d" e')).toBe(`mysql "x -p${SECRET_MASK} e`);
    // 没有闭引号：打到行尾，下一行照旧。
    expect(maskSecrets("mysql's x -p'ab;cd&ef\nmkdir -pv out")).toBe(`mysql's x -p${SECRET_MASK}\nmkdir -pv out`);
    // 往后打过的那段里出现的命令名不再当成新命令（不然会把那段原样吐出来）。
    expect(maskSecrets("mysql's x -p'ab;cd mysql e' f")).toBe(`mysql's x -p${SECRET_MASK} f`);
    // 往后打到闭引号，再接着打紧连着的字（bash 会接成同一个词）；空白、; 后面的不动。
    expect(maskSecrets("mysql's x -p'ab;cd'ef g; ls")).toBe(`mysql's x -p${SECRET_MASK} g; ls`);
    // 闭合了的照旧，后面的命令不动。
    expect(maskSecrets("mysql -p'a;b' x; mkdir -pv y")).toBe(`mysql -p${SECRET_MASK} x; mkdir -pv y`);
    expect(maskSecrets("sshpass -p 'a;b' ssh h; tar -pxf x")).toBe(`sshpass -p ${SECRET_MASK} ssh h; tar -pxf x`);
  });

  it("masks Markdown bold keys, table rows, backticked 'is' and full-width quotes", () => {
    expect(maskSecrets("- **Password**: `hunter2xyz`")).toBe(`- **Password**: \`${SECRET_MASK}\``);
    expect(maskSecrets("- **DEPLOY_PASS**: hunter2xyz")).toBe(`- **DEPLOY_PASS**: ${SECRET_MASK}`);
    expect(maskSecrets("**password:** hunter2xyz")).toBe(`**password:** ${SECRET_MASK}`);
    expect(maskSecrets("__token__: hunter2xyz")).toBe(`__token__: ${SECRET_MASK}`);
    expect(maskSecrets("| password | hunter2xyz |")).toBe(`| password | ${SECRET_MASK} |`);
    expect(maskSecrets("| `DEPLOY_PASS` | `two words` |")).toBe(`| \`DEPLOY_PASS\` | \`${SECRET_MASK}\` |`);
    expect(maskSecrets("| api_key | abcd1234efgh |")).toBe(`| api_key | ${SECRET_MASK} |`);
    // 不在表格第一列的 | 不算：echo $token | grep 里的 grep 不是值。
    expect(maskSecrets("echo $token | grep foo")).toBe("echo $token | grep foo");
    expect(maskSecrets("`token` is hunter2xyz")).toBe(`\`token\` is ${SECRET_MASK}`);
    expect(maskSecrets("`token` is `two words`")).toBe(`\`token\` is \`${SECRET_MASK}\``);
    expect(maskSecrets("token：“abc 123”")).toBe(`token：“${SECRET_MASK}”`);
    expect(maskSecrets("密码：‘ab cd’ 记一下")).toBe(`密码：‘${SECRET_MASK}’ 记一下`);
    expect(maskSecrets("token：“abc 123")).toBe(`token：“${SECRET_MASK}`);
    // JSON 里转义的双引号不算闭引号。
    expect(maskSecrets('{"password": "a\\"b c"}')).toBe(`{"password": "${SECRET_MASK}"}`);
  });

  it("masks full-width quotes that never close, smart quotes inside a value and escaped quotes in an unclosed value", () => {
    // 全角引号没闭合：打到行尾，下一行照旧。
    expect(maskSecrets("token：“abc 123\n下一行")).toBe(`token：“${SECRET_MASK}\n下一行`);
    expect(maskSecrets("token is “abc")).toBe(`token is “${SECRET_MASK}`);
    expect(maskSecrets(maskSecrets("token：“abc 123”"))).toBe(`token：“${SECRET_MASK}”`);
    // 全角引号出现在值的中间（智能引号的 it’s）：照打整串，不能只打到引号前面。
    expect(maskSecrets("password: it’ssecret99")).toBe(`password: ${SECRET_MASK}`);
    expect(maskSecrets("password: ab“cdef1234")).toBe(`password: ${SECRET_MASK}`);
    expect(maskSecrets("the password is: it’s99")).toBe(`the password is: ${SECRET_MASK}`);
    // ASCII 的 ' 后面紧跟字母、数字的算进值；闭引号不算（key: 'ArrowDown'、 仍然放过）。
    expect(maskSecrets("password: it'ssecret99")).toBe(`password: ${SECRET_MASK}`);
    expect(maskSecrets("key: 'ArrowDown'、x")).toBe("key: 'ArrowDown'、x");
    // 带撇号的普通话不算「X is Y」里的密钥。
    expect(maskSecrets("the token is user's")).toBe("the token is user's");
    expect(maskSecrets("the token is don’t.")).toBe("the token is don’t.");
    // 全角引号的键名。
    expect(maskSecrets("“password”: “abc 123”")).toBe(`“password”: “${SECRET_MASK}”`);
    expect(maskSecrets("“password”: hunter2xyz")).toBe(`“password”: ${SECRET_MASK}`);
    // 没闭合的双引号、单引号值里有转义的 \" \'：打到行尾。
    expect(maskSecrets('password: "ab\\"cdefgh123\nnext')).toBe(`password: "${SECRET_MASK}\nnext`);
    expect(maskSecrets("password: 'ab\\'cdefgh123\nnext")).toBe(`password: '${SECRET_MASK}\nnext`);
    // 值里还有空格：只有认转义的规则能打到行尾（不然只打到空格前）。
    expect(maskSecrets("password: 'ab\\'cd efgh\nnext")).toBe(`password: '${SECRET_MASK}\nnext`);
    // 闭合了的单引号值里转义的 \'：不算闭引号。
    expect(maskSecrets("password: 'it\\'s a secret' ok")).toBe(`password: '${SECRET_MASK}' ok`);
  });

  it("masks italic keys, 「」『』 quoted values and -p values joined to a quote", () => {
    expect(maskSecrets("*password*: hunter2xyz")).toBe(`*password*: ${SECRET_MASK}`);
    expect(maskSecrets("_password_: hunter2xyz")).toBe(`_password_: ${SECRET_MASK}`);
    expect(maskSecrets("*password:* hunter2xyz")).toBe(`*password:* ${SECRET_MASK}`);
    // 值开头的 _ * 不当成斜体的收尾留在外面。
    expect(maskSecrets("password: _abcd1234")).toBe(`password: ${SECRET_MASK}`);
    expect(maskSecrets("password:*abcd1234")).toBe(`password:${SECRET_MASK}`);
    expect(maskSecrets("the password is: _abcd1234")).toBe(`the password is: ${SECRET_MASK}`);
    expect(maskSecrets("密码：「abc 123」")).toBe(`密码：「${SECRET_MASK}」`);
    expect(maskSecrets("密码：『abc 123』 好")).toBe(`密码：『${SECRET_MASK}』 好`);
    expect(maskSecrets("密码：「abc 123\n下一行")).toBe(`密码：「${SECRET_MASK}\n下一行`);
    expect(maskSecrets("「密码」：hunter2xyz")).toBe(`「密码」：${SECRET_MASK}`);
    expect(maskSecrets(maskSecrets("密码：「abc 123」"))).toBe(`密码：「${SECRET_MASK}」`);
    expect(maskSecrets("mysql -p'x'tail db")).toBe(`mysql -p${SECRET_MASK} db`);
    expect(maskSecrets('mysql -pa"b c"d db')).toBe(`mysql -p${SECRET_MASK} db`);
    expect(maskSecrets("sshpass -p 'a b'c ssh h")).toBe(`sshpass -p ${SECRET_MASK} ssh h`);
  });

  it("masks the key columns of a table whose header names them, Markdown and mysql output alike", () => {
    const md = "| user | password |\n|---|---|\n| admin | hunter2xyz |\n| bob | two words |\n\nafter | x";
    expect(maskSecrets(md)).toBe(`| user | password |\n|---|---|\n| admin | ${SECRET_MASK} |\n| bob | ${SECRET_MASK} |\n\nafter | x`);
    // 没有外侧 | 的写法。
    expect(maskSecrets("user | password\n--- | ---\nadmin | hunter2xyz")).toBe(`user | password\n--- | ---\nadmin | ${SECRET_MASK}`);
    // mysql 的查询结果：最后一行数据下面的 +---+ 不让它变成新的表头。
    const mysql = ["+-------+----------+", "| user  | password |", "+-------+----------+", "| admin | hunter2  |", "| bob   | x        |", "+-------+----------+"];
    expect(maskSecrets(mysql.join("\n")).split("\n")).toEqual([
      mysql[0],
      mysql[1],
      mysql[2],
      `| admin | ${SECRET_MASK}  |`,
      `| bob   | ${SECRET_MASK}        |`,
      mysql[5],
    ]);
    // 粗体、反引号、大写的表头；CRLF；转义的 \| 不算格子的分隔。
    expect(maskSecrets("| `note` | **API_KEY** |\r\n|:--|--:|\r\n| ok | ab\\|cd |\r\n")).toBe(`| \`note\` | **API_KEY** |\r\n|:--|--:|\r\n| ok | ${SECRET_MASK} |\r\n`);
    // 表头不是键名的表、表格结束后的行不动。
    expect(maskSecrets("| name | value |\n|---|---|\n| a | b |")).toBe("| name | value |\n|---|---|\n| a | b |");
    expect(maskSecrets("| user | password |\n|---|---|\n| a | b |\n\n| c | d |")).toBe(`| user | password |\n|---|---|\n| a | ${SECRET_MASK} |\n\n| c | d |`);
    // 第一列是键名的表格行（没有表头），小写带 _ 的键名也算。
    expect(maskSecrets("| db_password | hunter2xyz |")).toBe(`| db_password | ${SECRET_MASK} |`);
    // 不是第一列的「| token |」也会打掉后面的值（误打可以接受）。
    expect(maskSecrets("a | token | grep foo")).toBe(`a | token | ${SECRET_MASK} foo`);
  });

  it("masks values with ASCII quotes in the middle, -p values with escaped spaces and more table shapes (round 8)", () => {
    // 值中间的 ASCII 引号后面跟着符号：整串打（以前只打到引号前面、或者前面不到 4 个字就整串漏掉）。
    for (const v of ["Pa'$$w0rd", "Tr0ub4dor'&3", "ab\"cdef1234", "x9'\"Lm!q", "ab`cd`ef1234", "abc'-123xyz"]) {
      expect(maskSecrets(`password: ${v}`), v).toBe(`password: ${SECRET_MASK}`);
    }
    // 闭引号后面是标点、空白、括号的不算进值。
    expect(maskSecrets("key=“ArrowDown”")).toBe("key=“ArrowDown”");
    expect(maskSecrets("key=『ArrowDown』")).toBe("key=『ArrowDown』");
    expect(maskSecrets("password: hunter2xyz”。")).toBe(`password: ${SECRET_MASK}”。`);
    expect(maskSecrets("{'token=abc123def'}")).toBe(`{'token=${SECRET_MASK}'}`);
    // 闭引号当开引号用（打错）：照打。
    expect(maskSecrets("密码：」abc123def")).toBe(`密码：」${SECRET_MASK}`);
    // -p 的值里 \ 转义的空白是同一个 shell 词。
    expect(maskSecrets("mysql -pMy\\ Secret\\ 123 db")).toBe(`mysql -p${SECRET_MASK} db`);
    // 引号不在值的开头、在 ; 前没闭合：往后打到闭引号（只看首字的写法会漏掉 c）。
    expect(maskSecrets("mysql's -pa'b;c' d")).toBe(`mysql's -p${SECRET_MASK} d`);
    // 往后打的时候又碰到引号：接着打到它的闭引号；打到引号外的 ; 停。
    expect(maskSecrets("mysql's -p'a;b'c\"d e\" f")).toBe(`mysql's -p${SECRET_MASK} f`);
    expect(maskSecrets("mysql's -p'a;b'c;ls")).toBe(`mysql's -p${SECRET_MASK};ls`);
    // mysql -t -e "q1; q2"：两张表之间没有空行，第二张表的表头照样认。
    const two = ["+----+------+", "| id | name |", "+----+------+", "| 1  | a    |", "+----+------+", "+----+----------+", "| id | password |", "+----+----------+", "| 1  | hunter2  |", "+----+----------+"];
    const masked = maskSecrets(two.join("\n")).split("\n");
    expect(masked[3]).toBe("| 1  | a    |");
    expect(masked[6]).toBe("| id | password |");
    expect(masked[8]).toBe(`| 1  | ${SECRET_MASK}  |`);
    // 空行之后的第二张表：重新认表头。
    expect(maskSecrets("| a | b |\n|---|---|\n| 1 | 2 |\n\n| user | password |\n|---|---|\n| u | hunter2 |")).toBe(
      `| a | b |\n|---|---|\n| 1 | 2 |\n\n| user | password |\n|---|---|\n| u | ${SECRET_MASK} |`,
    );
    // 表头格子里含键名就算（不必是整格），引用块里的表格也算。
    for (const h of ["Access Token", "DB Password", "password (prod)", "数据库密码", "License Key"]) {
      expect(maskSecrets(`| user | ${h} |\n|---|---|\n| a | hunter2 |`), h).toBe(`| user | ${h} |\n|---|---|\n| a | ${SECRET_MASK} |`);
    }
    expect(maskSecrets("> | user | password |\n> |---|---|\n> | a | hunter2 |")).toBe(`> | user | password |\n> |---|---|\n> | a | ${SECRET_MASK} |`);
  });

  it("tells a mysql table's last data row from the next table's header, and ends a table at a blank line", () => {
    // mysql 的最后一行数据下面也有 +---+：密码值里含键名（secret_2024!）也不能当成表头放过，单行、多行的表都一样。
    for (const rows of [["| 1  | x        |", "| 2  | secret_2024! |"], ["| 2  | secret_2024! |"]]) {
      const t = ["+----+----------+", "| id | password |", "+----+----------+", ...rows, "+----+----------+"].join("\n");
      expect(maskSecrets(t), rows.join()).not.toContain("secret_2024");
    }
    // Markdown 表里紧跟着 |---| 的一行是下一张表的表头：那一格的键名不打，这一列在下面照打。
    expect(maskSecrets("| a | b |\n|---|---|\n| 1 | 2 |\n| user | password |\n|---|---|\n| u | hunter2 |")).toBe(
      `| a | b |\n|---|---|\n| 1 | 2 |\n| user | password |\n|---|---|\n| u | ${SECRET_MASK} |`,
    );
    // 空行把表结束掉：后面那张表头不是键名的表，上一张表的密钥列不再打。
    expect(maskSecrets("| a | password |\n|---|---|\n| 1 | x |\n\n| note | user |\n|---|---|\n| hi | bob |")).toBe(
      `| a | password |\n|---|---|\n| 1 | ${SECRET_MASK} |\n\n| note | user |\n|---|---|\n| hi | bob |`,
    );
    // 空行之后的 mysql 表：表头上面只有一条 +---+，要重新当成新表认表头。
    const afterBlank = ["| a | b |", "|---|---|", "| 1 | 2 |", "", "+----+----------+", "| id | password |", "+----+----------+", "| 1  | hunter2  |", "+----+----------+"];
    expect(maskSecrets(afterBlank.join("\n")).split("\n")[7]).toBe(`| 1  | ${SECRET_MASK}  |`);
    // 只用 \r 换行的文本（老式 Mac）也按行认表。
    expect(maskSecrets("| user | password |\r|---|---|\r| a | hunter2 |")).toBe(`| user | password |\r|---|---|\r| a | ${SECRET_MASK} |`);
    // 表头含 key / token 这个词就整列打（误打可以接受）。
    expect(maskSecrets("| Primary Key | name |\n|---|---|\n| 42 | bob |")).toBe(`| Primary Key | name |\n|---|---|\n| ${SECRET_MASK} | bob |`);
  });

  it("round 9: tables right under a piped command, data rows above a rule, escaped | ; & in -p, quoted values after empty quotes", () => {
    // 表格上面紧挨着一行带 | 的命令：那行被当成了表头，真表头要在下面再认一次。
    for (const cmd of ['$ mysql -t -e "select user, password from users" | cat', '$ docker exec db mysql -t -e "select * from t" 2>&1 | tee out.txt', "INFO | query"]) {
      const t = [cmd, "+------+-------------+", "| user | password    |", "+------+-------------+", "| bob  | hunter2xyz1 |", "+------+-------------+"].join("\n");
      expect(maskSecrets(t), cmd).not.toContain("hunter2xyz1");
    }
    // 下面跟着分隔行的数据行（org 表格的 |---+---|、Markdown 里分组的 |---|）：含键名的值照打。
    for (const rule of ["|------+----------|", "|---|---|"]) {
      const t = ["| user | password |", rule, "| bob  | secret_2024! |", rule, "| amy  | p@ss12xx |"].join("\n");
      expect(maskSecrets(t), rule).not.toContain("secret_2024");
    }
    // 上一张表的密钥列在下一张表里照打（宁可误打）。
    expect(maskSecrets("| user | password |\n|---|---|\n| bob | x1 |\n| id | note |\n|---|---|\n| 1 | hi |")).toBe(
      `| user | password |\n|---|---|\n| bob | ${SECRET_MASK} |\n| id | ${SECRET_MASK} |\n|---|---|\n| 1 | ${SECRET_MASK} |`,
    );
    // 下一张表的键名列换了位置：两列都打（不是换掉）。
    expect(maskSecrets("| user | password |\n|---|---|\n| bob | x1 |\n| token | note |\n|---|---|\n| t9 | p2 |")).toBe(
      `| user | password |\n|---|---|\n| bob | ${SECRET_MASK} |\n| token | ${SECRET_MASK} |\n|---|---|\n| ${SECRET_MASK} | ${SECRET_MASK} |`,
    );
    // 列号不是从小到大并进来的：后面那列照打（maskRow 走到格子用完就停，cols 要排好序）。
    expect(maskSecrets("| a | b | password |\n|---|---|---|\n| 1 | 2 | p1 |\n| token | x | y |\n|---|---|---|\n| t1 |")).not.toContain("t1");
    // -p 的值里 \ 转义的 | ; &：bash 里是同一个词。
    for (const v of ["My\\;Secret123", "ab\\|cdef123", "ab\\&cdef123"]) {
      expect(maskSecrets(`mysql -uroot -p${v} db`), v).toBe(`mysql -uroot -p${SECRET_MASK} db`);
      expect(maskSecrets(`sshpass -p ${v} ssh h`), v).toBe(`sshpass -p ${SECRET_MASK} ssh h`);
    }
    // 引号外 \" 不算开引号；后面真开的引号在 ; 前没闭合，往后打到闭引号。
    expect(maskSecrets('mysql -pa\\"b"c;d e" f')).toBe(`mysql -p${SECRET_MASK} f`);
    // 闭引号后面 \ 转义的空白还是同一个词。
    expect(maskSecrets("mysql's -p'a;b'c\\ d e")).toBe(`mysql's -p${SECRET_MASK} e`);
    // 空引号后面是带引号的值（多个词）：整段打。
    for (const [k, e] of [["\"\"", '"'], ["''", "'"], ["“”", "“"]] as const) {
      expect(maskSecrets(`password: ${k} ${e}my secret phrase`), k).not.toContain("secret phrase");
      expect(maskSecrets(`DB_PASS=${k} ${e}my secret phrase`), k).not.toContain("secret phrase");
    }
    // 闭引号后面是这些标点：引号不算进值（单独的 key 的纯字母值放过）。
    for (const c of [")", "]", "}", ">", ",", ";", "，", "。", "；", "、", " "]) {
      expect(maskSecrets(`key: 'ArrowDown'${c}x`), c).toBe(`key: 'ArrowDown'${c}x`);
    }
    // 值中间的全角引号后面还有字：整串打。
    for (const q of ["“", "”", "‘", "’", "「", "」", "『", "』"]) {
      expect(maskSecrets(`password: ab${q}cdef1234`), q).toBe(`password: ${SECRET_MASK}`);
    }
    // 表头格子正好 128 字也算。
    expect(maskSecrets(`| ${"password " + "x".repeat(119)} |\n|---|\n| hunter2 |`)).not.toContain("hunter2");
    // 每种空引号都认（值紧跟在后面）。
    for (const k of ['""', "''", "``", "“”", "‘’", "「」", "『』"]) {
      for (const pre of ["password: ", "DB_PASS=", "key: ", "| token | "]) {
        expect(maskSecrets(`${pre}${k}abc123defg`), pre + k).not.toContain("abc123defg");
      }
    }
    // 值前面的全角闭引号（打错的开引号）两种都认。
    expect(maskSecrets("password: 』abc123def")).toBe(`password: 』${SECRET_MASK}`);
  });

  it("round 9 suggestions: grid tables, camelCase and plural headers, authentication_string, text after a closing quote, ab')cdef", () => {
    // 1 tabulate / pandoc grid：表头下面是 +====+。
    const grid = ["+------+----------+", "| user | password |", "+======+==========+", "| bob  | hunter2  |", "+------+----------+"].join("\n");
    expect(maskSecrets(grid)).toBe(grid.replace("hunter2", SECRET_MASK));
    expect(maskSecrets("| password |\n|====|\n| hunter2 |")).toBe(`| password |\n|====|\n| ${SECRET_MASK} |`);
    // = 号的普通行不是分隔行（有字的不算）。
    expect(maskSecrets("| password |\na = b\n| hunter2 |")).toBe("| password |\na = b\n| hunter2 |");
    // 2 驼峰、复数的表头。
    for (const h of ["accessToken", "dbPassword", "APIKey", "clientSecret", "tokens", "passwords", "Secrets", "API Keys"]) {
      // APIKey、clientSecret 整格就是键名，旁边那格（name）还会被 TABLE_KEY 误打，这里只看下面的值。
      const out = maskSecrets(`| ${h} | name |\n|---|---|\n| v4lue | bob |`);
      expect(out, h).not.toContain("v4lue");
      expect(out, h).toContain("| bob |");
    }
    // 连着几个大写字母再接驼峰的（DBPassword、OAuthToken）也拆开；拆开会切断的整词（PassWord、PassPhrase）原样也认。
    for (const h of ["DBPassword", "OAuthToken", "PassWord", "PassPhrase", "PassWd", "PASSWord", "TOKENs"]) {
      expect(maskSecrets(`| ${h} | name |\n|---|---|\n| v4lue | bob |`), h).not.toContain("v4lue");
    }
    // 词中间的 key 不算（monkey、Keystone、hotkeys）。
    for (const h of ["monkey", "Keystone", "hotkeys"]) {
      expect(maskSecrets(`| ${h} |\n|---|\n| v4lue |`), h).toBe(`| ${h} |\n|---|\n| v4lue |`);
    }
    // 3 mysql.user 的 authentication_string：表头列、\G 的竖排输出、* 加 40 位 hex。
    const hash = "*2470C0C06DEE42FD1618BB99005ADCA2EC9D1E19";
    expect(maskSecrets(`| user | authentication_string |\n|---|---|\n| root | ${hash} |`)).toBe(`| user | authentication_string |\n|---|---|\n| root | ${SECRET_MASK} |`);
    expect(maskSecrets(`authentication_string: ${hash}`)).toBe(`authentication_string: ${SECRET_MASK}`);
    expect(maskSecrets(`hash ${hash} done`)).toBe(`hash *${SECRET_MASK} done`);
    // 不跟在 * 后面的 40 位 hex 还是 commit SHA。
    expect(maskSecrets(`commit ${hash.slice(1)}`)).toBe(`commit ${hash.slice(1)}`);
    // 4 闭引号后面紧跟着字：接着打到这个词结束（几段引号接起来的也算）。
    expect(maskSecrets("password: 'abc'def123")).toBe(`password: '${SECRET_MASK}'${SECRET_MASK}`);
    expect(maskSecrets("export TOKEN='abc'\"def\" next")).toBe(`export TOKEN='${SECRET_MASK}'${SECRET_MASK} next`);
    expect(maskSecrets("DB_PASS='abc'\"de f")).toBe(`DB_PASS='${SECRET_MASK}'${SECRET_MASK}`);
    expect(maskSecrets("export TOKEN=\"abc\"'de f' next")).toBe(`export TOKEN="${SECRET_MASK}"${SECRET_MASK} next`);
    expect(maskSecrets("password: “abc”def12、ok")).toBe(`password: “${SECRET_MASK}”${SECRET_MASK}、ok`);
    expect(maskSecrets("| password | 'abc'def | x |")).toBe(`| password | '${SECRET_MASK}'${SECRET_MASK} | x |`);
    // 闭引号后面是空白、标点、括号的不动。
    for (const c of [" ", ",", ";", ")", "]", "}", ">", "|", "，", "。", "；", "、"]) {
      expect(maskSecrets(`password: 'abc'${c}def`), c).toBe(`password: '${SECRET_MASK}'${c}def`);
    }
    // 单独的 key 的纯字母值没打码，后面的字不接着打。
    expect(maskSecrets("key: 'ArrowDown')x")).toBe("key: 'ArrowDown')x");
    // 值前面的可选引号（VQ）：单独的 key 的值以引号开头、引号值后面紧跟着字时，整串算一个值（不再是纯字母的键名），照打。
    for (const [o, c] of [["`", "`"], ["“", "”"], ["‘", "’"], ["「", "」"], ["『", "』"]]) {
      expect(maskSecrets(`key: ${o}ArrowDown${c}x2`), o).toBe(`key: ${o}${SECRET_MASK}`);
    }
    // 打错成闭引号的开引号（” ’）：值照打。
    for (const q of ["”", "’"]) {
      expect(maskSecrets(`password: ${q}abc123def`), q).toBe(`password: ${q}${SECRET_MASK}`);
    }
    // 5 前面没有开引号的值：引号后面跟着括号再接着字，整串打。
    for (const v of ["ab')cdef123", 'ab")cdef123', "ab']]cdef123", "ab'}>cdef123", "ab’)cdef123"]) {
      expect(maskSecrets(`password: ${v}`), v).toBe(`password: ${SECRET_MASK}`);
      expect(maskSecrets(`DB_PASS=${v}`), v).toBe(`DB_PASS=${SECRET_MASK}`);
      expect(maskSecrets(`key: ${v}`), v).toBe(`key: ${SECRET_MASK}`);
      expect(maskSecrets(`| token | ${v} |`), v).toBe(`| token | ${SECRET_MASK} |`);
    }
    // 括号后面是空白、标点或结尾：引号和括号不算进值。
    expect(maskSecrets("(password: hunter2'), next")).toBe(`(password: ${SECRET_MASK}'), next`);
    expect(maskSecrets("f(password: hunter2')")).toBe(`f(password: ${SECRET_MASK}')`);
    // 空引号后面带引号的值：单独的 key、表格的 | token | 也认。
    expect(maskSecrets('key: "" "abc def123"')).toBe(`key: "" "${SECRET_MASK}"`);
    expect(maskSecrets('| token | "" "my secret phrase" |')).toBe(`| token | "" "${SECRET_MASK}" |`);
    expect(maskSecrets("API_TOKEN='' 'my secret phrase")).toBe(`API_TOKEN='' '${SECRET_MASK}`);
  });

  it("masks a value after an empty pair of quotes and an unclosed value ending in a lone backslash", () => {
    expect(maskSecrets("password: “” hunter2xyz")).toBe(`password: “” ${SECRET_MASK}`);
    expect(maskSecrets("密码：『』abc123def")).toBe(`密码：『』${SECRET_MASK}`);
    expect(maskSecrets('DB_PASSWORD="" hunter2xyz')).toBe(`DB_PASSWORD="" ${SECRET_MASK}`);
    // 空值本身不动。
    expect(maskSecrets('{"password": "", "user": "bob"}')).toBe('{"password": "", "user": "bob"}');
    // 行尾单独一个 \：整段打到行尾（不然只打掉第一个词）。
    expect(maskSecrets('password: "hunter two\\')).toBe(`password: "${SECRET_MASK}`);
    expect(maskSecrets("password: 'hunter two\\\nnext")).toBe(`password: '${SECRET_MASK}\nnext`);
  });

  it("only lets a ticket-key slug through when every part after the key is plain lowercase or at most 4 characters", () => {
    const keep = [
      "https://github.com/yul761/Shipherd/tree/feature/BTL-272-secret-masking",
      "https://github.com/yul761/Shipherd/tree/feature/BTL-272-fix-h264-decoder-v2",
    ];
    for (const url of keep) expect(maskSecrets(url)).toBe(url);
    for (const slug of [
      "BTL-9-550e8400-e29b-41d4-a716-446655440000",
      "BTL-9-k3j5h7g9f1d3s5a-q2w3e4r5t6y7u8i",
      "BTL-1-AbcDefGhiJklMnoPqrStuVwx",
      // 每段都是纯小写字母的 UUID 也照打。
      "BTL-9-abcdefab-abcd-abcd-abcd-abcdefabcdef",
      // 带数字、超过 4 个字的段。
      "BTL-9-x1y2z-a1b2c-d4e5f-g7h8i-j9k0l",
    ]) {
      expect(maskSecrets(`https://x.example.com/s/${slug}`), slug).toBe(`https://x.example.com/s/${SECRET_MASK}`);
    }
  });

  it("masks an unclosed quoted value with spaces up to the end of the line", () => {
    expect(maskSecrets('password: "two words')).toBe(`password: "${SECRET_MASK}`);
    expect(maskSecrets("password = 'hunter 2")).toBe(`password = '${SECRET_MASK}`);
    expect(maskSecrets('password: "two words\r\nnext line')).toBe(`password: "${SECRET_MASK}\r\nnext line`);
    expect(maskSecrets('DB_PASSWORD="two words\nnext')).toBe(`DB_PASSWORD="${SECRET_MASK}\nnext`);
    expect(maskSecrets('DEPLOY_PASS="two words\nnext')).toBe(`DEPLOY_PASS="${SECRET_MASK}\nnext`);
    // 闭合了的照旧只打引号里的。
    expect(maskSecrets('password: "two words" ok')).toBe(`password: "${SECRET_MASK}" ok`);
    expect(maskSecrets(maskSecrets('password: "two words'))).toBe(`password: "${SECRET_MASK}`);
  });

  it("round 10: numbered key names, run-together and pass headers, quotes after a closing quote, empty quotes after 'is', \\ line continuations", () => {
    const M = SECRET_MASK;
    // a：键名带数字编号。
    expect(maskSecrets("token1=abcdefgh12")).toBe(`token1=${M}`);
    expect(maskSecrets("password1: hunter2xyz")).toBe(`password1: ${M}`);
    expect(maskSecrets("pwd22 = s3cr3tvalue")).toBe(`pwd22 = ${M}`);
    expect(maskSecrets("DB_PASSWORD_1=hunter2xyz")).toBe(`DB_PASSWORD_1=${M}`);
    expect(maskSecrets("API_KEY2=abcd1234")).toBe(`API_KEY2=${M}`);
    expect(maskSecrets("key2=abcdefgh123")).toBe(`key2=${M}`);
    expect(maskSecrets('password2: "two words"')).toBe(`password2: "${M}"`);
    expect(maskSecrets('key2: "abc def 123"')).toBe(`key2: "${M}"`);
    expect(maskSecrets("| pwd2 | s3cr3tvalue |")).toBe(`| pwd2 | ${M} |`);
    expect(maskSecrets("| key3 | s3cr3tvalue |")).toBe(`| key3 | ${M} |`);
    expect(maskSecrets("| DB_TOKEN_2 | s3cr3tvalue |")).toBe(`| DB_TOKEN_2 | ${M} |`);
    expect(maskSecrets("the token2 is abc123def")).toBe(`the token2 is ${M}`);
    for (const h of ["password1", "pwd2", "Token2", "API_KEY_3", "tokens2"]) {
      {
        const out = maskSecrets(`| ${h} | name |\n|---|---|\n| v4lue | bob |`);
        expect(out, h).not.toContain("v4lue");
        expect(out, h).toContain(`|---|---|\n| ${M} | bob |`);
      }
    }
    // b：全大写或全小写连写的表头、credentials、pass、pass word、PassCode。
    for (const h of ["DBPASSWORD", "dbpassword", "SECRETKEY", "DBSECRET", "userpwd", "APITOKENS", "credentials", "awscredential", "Credential", "pass", "Pass", "pass word", "Pass_word", "PassCode", "passcode"]) {
      {
        const out = maskSecrets(`| ${h} | name |\n|---|---|\n| v4lue | bob |`);
        expect(out, h).not.toContain("v4lue");
        expect(out, h).toContain(`|---|---|\n| ${M} | bob |`);
      }
    }
    // 连写的规则不认 key、pass（monkey、passenger、Passenger）。
    for (const h of ["Passenger", "monkey", "passenger", "KEYSTONE", "BYPASS"]) {
      expect(maskSecrets(`| ${h} | name |\n|---|---|\n| v4lue | bob |`), h).toContain("v4lue");
    }
    expect(maskSecrets("credentials: abcd1234")).toBe(`credentials: ${M}`);
    expect(maskSecrets("passcode=834912ab")).toBe(`passcode=${M}`);
    // c：闭引号后面紧跟着反引号、全角开引号的一段，整段接着打。
    expect(maskSecrets("password: 'abc'`def123`")).toBe(`password: '${M}'${M}`);
    expect(maskSecrets("password: 'abc'`def")).toBe(`password: '${M}'${M}`);
    expect(maskSecrets("密码：“abc”‘def123’")).toBe(`密码：“${M}”${M}`);
    expect(maskSecrets("密码：“abc”“def 123” ok")).toBe(`密码：“${M}”${M} ok`);
    expect(maskSecrets("secret: 「abc」「def 123」 ok")).toBe(`secret: 「${M}」${M} ok`);
    expect(maskSecrets("secret: 『abc』『def 123』 ok")).toBe(`secret: 『${M}』${M} ok`);
    expect(maskSecrets("TOKEN='abc'‘def 1’ ok")).toBe(`TOKEN='${M}'${M} ok`);
    // c：「is」后面先是一对空引号。
    expect(maskSecrets('the password is "" "my secret phrase"')).toBe(`the password is "" "${M}"`);
    expect(maskSecrets('the password is: "" "my secret phrase"')).toBe(`the password is: "" "${M}"`);
    expect(maskSecrets('the password is: "" hunter2xyz')).toBe(`the password is: "" ${M}`);
    expect(maskSecrets('the password is "" hunter2xyz')).toBe(`the password is "" ${M}`);
    // c：空引号后面没有开引号的值，引号后面跟着括号再接着字也算进值。
    expect(maskSecrets("password: ''ab')cd1234")).toBe(`password: ''${M}`);
    expect(maskSecrets('password: ""ab")cd1234 ok')).toBe(`password: ""${M} ok`);
    // 有开引号的值照旧：闭引号后面跟着括号的，括号留着。
    expect(maskSecrets("key: 'ArrowDown')x and more")).toBe("key: 'ArrowDown')x and more");
    // 用 \ 续行的多行命令：-p 在后面几行里也认。
    expect(maskSecrets("mysql -h db \\\n  -u admin \\\n  -pS3cretPass mydb")).toBe(`mysql -h db \\\n  -u admin \\\n  -p${M} mydb`);
    expect(maskSecrets("mysql -h db \\\r\n  -pS3cretPass mydb")).toBe(`mysql -h db \\\r\n  -p${M} mydb`);
    expect(maskSecrets("sshpass \\\n  -p S3cretPass ssh host")).toBe(`sshpass \\\n  -p ${M} ssh host`);
    expect(maskSecrets("docker login \\\n  -p S3cretPass reg")).toBe(`docker login \\\n  -p ${M} reg`);
    // 不续行的换行照旧断开命令。
    expect(maskSecrets("mysql -h db\n  -pS3cretPass")).toBe("mysql -h db\n  -pS3cretPass");
    // 续行落在 -p 和值之间：续行留着，后面的值照打（以前 sshpass / docker 把续行当成值打掉、真的值漏了）。
    expect(maskSecrets("sshpass -p \\\n  S3cretPass ssh host")).toBe(`sshpass -p \\\n  ${M} ssh host`);
    expect(maskSecrets("docker login -u x -p \\\n  S3cretPass reg")).toBe(`docker login -u x -p \\\n  ${M} reg`);
    expect(maskSecrets("docker login -u x -pS3cretPass reg")).toBe(`docker login -u x -p${M} reg`);
    expect(maskSecrets("mysql -h db -p\\\nS3cretPass")).toBe(`mysql -h db -p\\\n${M}`);
    expect(maskSecrets("mysql -h db -p \\\n  mydb")).toBe("mysql -h db -p \\\n  mydb");
    expect(maskSecrets("mysql -h db -p\\\n  mydb")).toBe("mysql -h db -p\\\n  mydb");
    expect(maskSecrets("docker login -u x --password \\\n  S3cretPass reg")).toBe(`docker login -u x --password \\\n  ${M} reg`);
  });

  it("round 11: uncapped and separated key-name numbers, run-together headers in any case", () => {
    const M = SECRET_MASK;
    for (const k of ["password123456789", "token1700000000", "password_1", "db_password_1", "token-2", "secret_key_1", "DB_PASSWORD_123456789", "API_KEY_1700000000", "key123456789", "密码123456789"]) {
      expect(maskSecrets(`${k}=hunter2xyz`), k).toBe(`${k}=${M}`);
    }
    expect(maskSecrets("the password123456789 is hunter2xyz")).toBe(`the password123456789 is ${M}`);
    expect(maskSecrets("| password123456789 | hunter2xyz |")).toBe(`| password123456789 | ${M} |`);
    // 第十轮的改动里没测到的（变异测试漏网）：_PASS 后面的编号、\ 续行在 -p 的值中间、编号键名接没闭合的引号和 is、两列密钥列的表头。
    expect(maskSecrets("DB_PASS2=hunter2xyz")).toBe(`DB_PASS2=${M}`);
    expect(maskSecrets("mysql -pab\\\ncdSecret")).toBe(`mysql -p${M}`);
    expect(maskSecrets("mysql -pab\\\r\ncdSecret")).toBe(`mysql -p${M}`);
    expect(maskSecrets('password2: "two words')).toBe(`password2: "${M}`);
    expect(maskSecrets('the token2 is "two words"')).toBe(`the token2 is "${M}"`);
    expect(maskSecrets("the password2 is: hunter")).toBe(`the password2 is: ${M}`);
    {
      const out = maskSecrets("| user | password | token |\n|---|---|---|\n| bob | v4lue1 | v4lue2 |");
      expect(out).not.toContain("v4lue1");
      expect(out).not.toContain("v4lue2");
    }
    for (const h of ["Password123456789", "Authtoken", "Dbpassword", "Userpwd", "Accesstoken", "Awscredentials", "Tokenizer", "Secretary"]) {
      const out = maskSecrets(`| ${h} | name |\n|---|---|\n| v4lue | bob |`);
      expect(out, h).not.toContain("v4lue");
    }
  });
  it("round 11 suggestions: plural and suffixed key names, env keys before 'is', continuations inside -p quotes, several empty quotes", () => {
    const M = SECRET_MASK;
    // a：复数。c：键名后面的一个单词后缀。
    for (const k of ["passwords", "tokens", "secrets", "DB_PASSWORDS", "DB_PASSWORD_PROD", "SECRET_KEY_A", "password_prod", "token-v2", "API_TOKEN_2_STAGING"]) {
      expect(maskSecrets(`${k}=hunter2xyz`), k).toBe(`${k}=${M}`);
      expect(maskSecrets(`${k}: hunter2xyz`), k).toBe(`${k}: ${M}`);
    }
    expect(maskSecrets("| password_prod | hunter2xyz |")).toBe(`| password_prod | ${M} |`);
    // 环境变量式的（大写、_ 连着）：后缀和复数由不分大小写的键名认（_auth 也在键名里）。
    for (const k of ["X_AUTH_PROD", "MY_KEY_PROD", "MY_KEYS", "API_TOKENS_V2"]) {
      expect(maskSecrets(`${k}=hunter2xyz`), k).toBe(`${k}=${M}`);
      expect(maskSecrets(`${k}='a b`), k).toBe(`${k}='${M}`);
    }
    // 分隔符后面的编号比后缀的 16 个字长：编号不设上限，照样认。
    expect(maskSecrets("password_123456789012345678=hunter2xyz")).toBe(`password_123456789012345678=${M}`);
    expect(maskSecrets("| token-123456789012345678 |\n|-|\n| v4lue |")).not.toContain("v4lue");
    // 后缀只认一段、最多 16 个字：再长就不算键名了，后面的值不按 key=value 打（这里没有别的规则会打它）。
    expect(maskSecrets("password_abcdefghijklmnopq=hunter")).toBe("password_abcdefghijklmnopq=hunter");
    // b：「X is Y」前面是环境变量式的键名。
    expect(maskSecrets("The DB_PASSWORD is hunter2xyz")).toBe(`The DB_PASSWORD is ${M}`);
    expect(maskSecrets("the API_TOKEN is: abc")).toBe(`the API_TOKEN is: ${M}`);
    expect(maskSecrets('The DB_PASSWORD is "two words"')).toBe(`The DB_PASSWORD is "${M}"`);
    // 键名紧挨着字母数字的不算（mypassword is …、xtoken is …）。
    expect(maskSecrets("the xtoken is hunter2xyz")).toBe("the xtoken is hunter2xyz");
    // d：-p 的引号里行尾 \ 续行。
    expect(maskSecrets("mysql -p'ab\\\ncd' rest")).toBe(`mysql -p${M} rest`);
    expect(maskSecrets('mysql -p"ab\\\ncd" rest')).toBe(`mysql -p${M} rest`);
    expect(maskSecrets("sshpass -p 'ab\\\r\ncd' ssh h")).toBe(`sshpass -p ${M} ssh h`);
    expect(maskSecrets("mysql -p'ab\\\ncd'; echo done")).toBe(`mysql -p${M}; echo done`);
    // e：好几对空引号。
    expect(maskSecrets('password: """" hunter2xyz')).toBe(`password: """" ${M}`);
    expect(maskSecrets('password: "" "" hunter2xyz')).toBe(`password: "" "" ${M}`);
    expect(maskSecrets('the password is "" "" "x y"')).toBe(`the password is "" "" "${M}"`);
    expect(maskSecrets("密码：「」『』abc123def")).toBe(`密码：「」『』${M}`);
    // f：「is」后面的值里有 ')。
    expect(maskSecrets("the password is ab')cdef123")).toBe(`the password is ${M}`);
    expect(maskSecrets("the password is: ab')cd")).toBe(`the password is: ${M}`);
    expect(maskSecrets("the password is: 'ab cd")).toBe(`the password is: '${M}`);
    expect(maskSecrets("the password is 'ab cd")).toBe(`the password is '${M}`);
    expect(maskSecrets('The DB_PASSWORD is "ab cd\nnext')).toBe(`The DB_PASSWORD is "${M}\nnext`);
  });

  it("round 11 (g): masks after normalizing full-width letters, zero-width characters and box-drawing tables", () => {
    const M = SECRET_MASK;
    expect(maskSecrets("ｐａｓｓｗｏｒｄ=hunter2xyz")).toBe(`password=${M}`);
    expect(maskSecrets("password＝hunter2xyz")).toBe(`password=${M}`);
    expect(maskSecrets("pass\u200bword=hunter2xyz")).toBe(`password=${M}`);
    expect(maskSecrets("to\u2060ken: hunter2xyz")).toBe(`token: ${M}`);
    expect(maskSecrets("\ufeffAPI_KEY=hunter2xyz")).toBe(`API_KEY=${M}`);
    expect(maskSecrets("│ password │ hunter2xyz │")).toBe(`| password | ${M} |`);
    expect(maskSecrets("| Ｐａｓｓｗｏｒｄ |\n|---|\n| v4lue |")).toBe(`| Password |\n|---|\n| ${M} |`);
    // psql 的 unicode 边框：横线、交叉也换成 ASCII，下面的数据行按表头的密钥列打。
    expect(maskSecrets(" user │ password\n──────┼──────────\n bob  │ v4lue")).toBe(` user | password\n------+----------\n bob  | ${M}`);
    {
      const out = maskSecrets("┌──────┬──────────┐\n│ user │ password │\n├──────┼──────────┤\n│ bob  │ v4lue    │\n└──────┴──────────┘");
      expect(out).not.toContain("v4lue");
    }
    // 中文标点不动：规则本来就认 ：，；（）。
    expect(maskSecrets("ｐａｓｓｗｏｒｄ：hunter2xyz，记一下")).toBe(`password：${M}，记一下`);
    // 只规范化有这些字的行：别的行原样。
    expect(maskSecrets("第一行，Ｈｉ\npassword＝hunter2xyz")).toBe(`第一行，Hi\npassword=${M}`);
    expect(maskSecrets("ＡＢＣ\n第二行：全角，标点")).toBe("ＡＢＣ\n第二行：全角，标点");
    // 没有密钥的：原文一个字都不改，hasSecret 也说没有。
    for (const t of ["ｐａｓｓ the ball，好", "全角，逗号：没事", "Ｈｅｌｌｏ ｗｏｒｌｄ", "┌──┐ box", "zero\u200bwidth", "│ name │ value │"]) {
      expect(maskSecrets(t), t).toBe(t);
      expect(hasSecret(t), t).toBe(false);
    }
    // 规范化以后打过码的不会再变（幂等）。
    const once = maskSecrets("ｐａｓｓｗｏｒｄ＝hunter2xyz");
    expect(maskSecrets(once)).toBe(once);
  });

  it("round 11 (h): an X_AUTH header still counts as a key column", () => {
    const out = maskSecrets("| X_AUTH | name |\n|---|---|\n| v4lue | bob |");
    expect(out).not.toContain("v4lue");
    expect(maskSecrets("| X_AUTH_2 | name |\n|---|---|\n| v4lue | bob |")).not.toContain("v4lue");
    // 不带 _ 的 auth 不算（author、authority）。
    expect(maskSecrets("| author | name |\n|---|---|\n| v4lue | bob |")).toContain("v4lue");
  });

  it("CI timing fix: a Cookie name stops at the next Cookie:, the next one masks the rest", () => {
    // 名字扫到下一个能起跑的 Cookie: 就停：停下来的那一段由下一个 Cookie: 打掉，一个字也不留。
    for (const s of ["Cookie: a-Cookie: b=s3cretvalue", "Cookie: a-Cookie:b=s3cretvalue", "Set-Cookie: x;Set-Cookie: sid=s3cretvalue", "cookie: a:Cookie: sid=s3cretvalue"]) {
      expect(maskSecrets(s), s).not.toContain("s3cretvalue");
    }
    // 没有 name= 的兜底规则也一样：带数字的长串在下一个 Cookie: 后面照打。
    expect(maskSecrets("Cookie: abc-Cookie:x1yz5678secret")).not.toContain("x1yz5678secret");
    // 字母紧挨着的 Cookie（aCookie:）不是新的起点，名字接着往后扫：整个 name=value 打掉。
    expect(maskSecrets("Cookie: aCookie:b=s3cretvalue")).not.toContain("s3cretvalue");
    // 词中间的 Cookie（fortuneCookie:）不是 Cookie 头。
    expect(maskSecrets("fortuneCookie: flavor=lemon")).toBe("fortuneCookie: flavor=lemon");
    // 名字 128 字以内照常认，前面的话留着。
    expect(maskSecrets(`see Cookie: ${"n".repeat(128)}=s3cretvalue here`)).toBe(`see Cookie: ${SECRET_MASK} here`);
  });

  it("CI timing fix: tables with CRLF, lone CR and mixed line breaks still mask the key column", () => {
    for (const br of ["\r\n", "\r", "\n"]) {
      const t = ["| user | password |", "|---|---|", "| bob | v4lue1 |", "| amy | v4lue2 |", "", "| v4lue3 |"].join(br);
      const out = maskSecrets(t);
      expect(out, JSON.stringify(br)).not.toMatch(/v4lue[12]/);
      // 空行把表格断开：后面那张没有表头，v4lue3 留着；换行符原样留着。
      expect(out).toContain("v4lue3");
      expect(out.split(br).length).toBe(6);
    }
    // 混着用的换行，最后一行没有换行。
    expect(maskSecrets("| token |\r\n|-|\r| v4lue |\n| v4lue2 |")).toBe(`| token |\r\n|-|\r| ${SECRET_MASK} |\n| ${SECRET_MASK} |`);
    // 转义的 \| 不切格；行尾的 \ 也照样算进最后一格。
    expect(maskSecrets("| token | n |\n|-|-|\n| a\\|b | c |\n| abc\\")).toBe(`| token | n |\n|-|-|\n| ${SECRET_MASK} | c |\n| ${SECRET_MASK}`);
    // 空格子不打（没有值可漏），已经打过的格子不重复打。
    const empty = "| user | password |\n|---|---|\n| bob |  |\n| amy ||";
    expect(maskSecrets(empty)).toBe(empty);
    // 一行都不用打的表格原样返回。
    const plain = "| user | name |\r\n|---|---|\r\n| bob | amy |";
    expect(maskSecrets(plain)).toBe(plain);
  });

  it("CI timing fix: every zero-width character is dropped before masking (U+200B, U+200C, U+200D, U+2060, U+FEFF)", () => {
    for (const z of ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff"]) {
      expect(maskSecrets(`pass${z}word=hunter2x`), JSON.stringify(z)).toBe(`password=${SECRET_MASK}`);
    }
  });

  it("CI timing fix: a header row needs one of the hint words, and every key-name form still has one", () => {
    for (const h of ["Password", "passwd", "PassPhrase", "pass word", "userpwd", "Secret", "accessToken", "APIKey", "api_key", "Credentials", "X_AUTH", "authentication_string", "数据库密码", "口令", "密钥", "令牌"]) {
      expect(maskSecrets(`| ${h} | name |\n|---|---|\n| v4lue | bob |`), h).not.toContain("v4lue");
    }
  });
  describe("review of fed50a04 (secrets)", () => {
    const M = SECRET_MASK;

    it("S1: a full-width colon counts as the colon in URL credentials, curl -u and Authorization", () => {
      expect(maskSecrets("postgres://admin：S3cretPw＠db.example.com/app")).toBe(`postgres://admin：${M}@db.example.com/app`);
      expect(maskSecrets("postgres://admin:S3cretPw＠db.example.com/app")).toBe(`postgres://admin:${M}@db.example.com/app`);
      expect(maskSecrets("curl -u admin：hunter2xyz https://x")).toBe(`curl -u admin：${M} https://x`);
      expect(maskSecrets("ｃｕｒｌ －ｕ ａｄｍｉｎ：ｈｕｎｔｅｒ２ｘｙｚ")).toBe(`curl -u admin：${M}`);
      expect(maskSecrets("ｔｏｋｅｎ：ａｂｃｄ１２３４ｅｆｇｈ")).toBe(`token：${M}`);
      expect(maskSecrets("Authorization：abcd1234efgh5678")).toBe(`Authorization：${M}`);
    });

    it("drops every Default_Ignorable code point before masking (soft hyphen, U+2063, variation selectors, tags)", () => {
      expect(maskSecrets("pass­word=hunter2xyz")).toBe(`password=${M}`);
      expect(maskSecrets("pass⁣word=hunter2xyz")).toBe(`password=${M}`);
      const missed: string[] = [];
      for (let cp = 0; cp <= 0x10ffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        const ch = String.fromCodePoint(cp);
        if (!/\p{Default_Ignorable_Code_Point}/u.test(ch)) continue;
        if (maskSecrets(`pass${ch}word=hunter2xyz`) !== `password=${M}`) missed.push(cp.toString(16));
      }
      expect(missed).toEqual([]);
      // 不可忽略的字照样留着（ß、é、汉字、® 不会被去掉，键名被它们隔开就不算键名）。
      for (const ch of ["ß", "é", "中", "®"]) expect(maskSecrets(`pass${ch}word=hunter2xyz`), ch).toBe(`pass${ch}word=hunter2xyz`);
    });

    it("maps every compatibility character whose NFKC is ASCII (math bold / italic / monospace, circled, superscript)", () => {
      expect(maskSecrets("𝐩𝐚𝐬𝐬𝐰𝐨𝐫𝐝=hunter2xyz")).toBe(`password=${M}`);
      expect(maskSecrets("𝚝𝚘𝚔𝚎𝚗: abcd1234efgh")).toBe(`token: ${M}`);
      expect(maskSecrets("ⓟⓐⓢⓢⓦⓞⓡⓓ=hunter2xyz")).toBe(`password=${M}`);
      expect(maskSecrets("𝐩𝐚𝐬𝐬: abc12345xyz")).toBe(`pass: ${M}`);
      // 每一个 NFKC 以后是 p 的字（各种数学字母、带圈、上下标、全角…）都要换过来。
      const missed: string[] = [];
      for (let cp = 0xa0; cp <= 0x1ffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        const ch = String.fromCodePoint(cp);
        if (ch.normalize("NFKC") !== "p") continue;
        if (maskSecrets(`${ch}assword=hunter2xyz`) !== `password=${M}`) missed.push(cp.toString(16));
      }
      expect(missed).toEqual([]);
      // 没打到码的原样返回（数学字母、℃、① 不改）。
      expect(maskSecrets("𝐇𝐞𝐥𝐥𝐨 ℃ ①")).toBe("𝐇𝐞𝐥𝐥𝐨 ℃ ①");
      // 打了码、输出用规范化文本时：NFKC 换不成 ASCII 的（℃ → °C、¼ → 1⁄4）不换。
      expect(maskSecrets("℃ ¼ password=hunter2xyz")).toBe(`℃ ¼ password=${M}`);
    });

    it("masks a value continued onto the next line with a backslash, and nothing when the next line is empty", () => {
      expect(maskSecrets("some-cli --token=\\\nS3cretPw")).toBe(`some-cli --token=\\\n${M}`);
      expect(maskSecrets("some-cli --password=\\\n  S3cretPw")).toBe(`some-cli --password=\\\n  ${M}`);
      expect(maskSecrets("curl -u bob:\\\nS3cretPw https://x")).toBe(`curl -u bob:\\\n${M} https://x`);
      expect(maskSecrets("curl -u \\\n bob:S3cretPw https://x")).toBe(`curl -u \\\n bob:${M} https://x`);
      expect(maskSecrets("curl --user \\\n  bob:S3cretPw https://x")).toBe(`curl --user \\\n  bob:${M} https://x`);
      expect(maskSecrets("PGPASSWORD=\\\nS3cretPw psql")).toBe(`PGPASSWORD=\\\n${M} psql`);
      expect(maskSecrets("password=\\\nS3cretPw")).toBe(`password=\\\n${M}`);
      expect(maskSecrets("password=\\\r\nS3cretPw")).toBe(`password=\\\r\n${M}`);
      expect(maskSecrets("key=\\\nabcdefgh1234")).toBe(`key=\\\n${M}`);
      // 续行后面什么都没有：不打（opus 的杀变异用例）；后面是带空格的引号值：整段打。
      expect(maskSecrets("some-cli --password \\\n")).toBe("some-cli --password \\\n");
      expect(maskSecrets('some-cli --password \\\n"S3cret Pw"')).toBe(`some-cli --password \\\n"${M}"`);
    });

    it("masks Authorization values with any scheme or none", () => {
      expect(maskSecrets("Authorization: token abcd1234efgh")).toBe(`Authorization: token ${M}`);
      expect(maskSecrets("Authorization: abcd1234efgh5678")).toBe(`Authorization: ${M}`);
      expect(maskSecrets("Authorization: Bot fake-bot-value-for-tests")).toBe(`Authorization: Bot ${M}`);
      expect(maskSecrets("Authorization: Negotiate YIIabc123def")).toBe(`Authorization: Negotiate ${M}`);
      expect(maskSecrets("authorization=Token abcd1234efgh")).toBe(`authorization=Token ${M}`);
      expect(maskSecrets("Authorization: Bearer abcd1234efgh5678")).toBe(`Authorization: ${M}`);
      // 8 个字以下的不打。
      expect(maskSecrets("Authorization: none")).toBe("Authorization: none");
    });

    it("masks a whole quoted command-line value with spaces (--password, --token, -u)", () => {
      expect(maskSecrets("some-cli --password 'S3cret Pw xyz'")).toBe(`some-cli --password '${M}'`);
      expect(maskSecrets('some-cli --password "S3cret Pw xyz"')).toBe(`some-cli --password "${M}"`);
      expect(maskSecrets("gh auth login --token 'ab cd ef'")).toBe(`gh auth login --token '${M}'`);
      expect(maskSecrets("some-cli --password='two words' x")).toBe(`some-cli --password='${M}' x`);
      expect(maskSecrets('some-cli --password "a\\" b c" next')).toBe(`some-cli --password "${M}" next`);
      expect(maskSecrets('some-cli --password "S3cret Pw')).toBe(`some-cli --password "${M}`);
      expect(maskSecrets("curl -u 'admin:S3cret Pw xyz' https://x")).toBe(`curl -u 'admin:${M}' https://x`);
      expect(maskSecrets('curl -u "admin:S3cret Pw xyz" https://x')).toBe(`curl -u "admin:${M}" https://x`);
      expect(maskSecrets('curl --user="bob:my pass" x')).toBe(`curl --user="bob:${M}" x`);
      expect(maskSecrets("-u 'admin:S3cret Pw xyz")).toBe(`-u 'admin:${M}`);
    });

    it("masks pass / pin keys and camelCase key names, but not words that only contain them", () => {
      expect(maskSecrets('{"db": {"pass": "hunter2xyz"}}')).toBe(`{"db": {"pass": "${M}"}}`);
      expect(maskSecrets('{"pin": "4821"}')).toBe(`{"pin": "${M}"}`);
      expect(maskSecrets("pinCode: 482193")).toBe(`pinCode: ${M}`);
      expect(maskSecrets("nodemailer auth: { user: 'bob', pass: 'hunter2xyz' }")).toBe(`nodemailer auth: { user: 'bob', pass: '${M}' }`);
      expect(maskSecrets("smtp:\n  user: bob\n  pass: hunter2xyz")).toBe(`smtp:\n  user: bob\n  pass: ${M}`);
      expect(maskSecrets("pass: 'two words here'")).toBe(`pass: '${M}'`);
      expect(maskSecrets('{"passwordHash": "hunter2xyz"}')).toBe(`{"passwordHash": "${M}"}`);
      expect(maskSecrets("tokenValue=abcd1234efgh")).toBe(`tokenValue=${M}`);
      expect(maskSecrets("| user | Pin |\n|---|---|\n| bob | 4821 |")).toBe(`| user | Pin |\n|---|---|\n| bob | ${M} |`);
      expect(maskSecrets("bypass: hunter2xyz")).toBe("bypass: hunter2xyz");
      expect(maskSecrets("spin: 1234abcd")).toBe("spin: 1234abcd");
      // opus 的杀变异用例：后缀长度、环境变量键名的长编号、驼峰的表头。
      expect(maskSecrets("db_password_staging: hunter2xyz")).toBe(`db_password_staging: ${M}`);
      expect(maskSecrets("token-preview=abcd1234efgh")).toBe(`token-preview=${M}`);
      expect(maskSecrets("MY_KEY_20240115093000123=hunter2xyz")).toBe(`MY_KEY_20240115093000123=${M}`);
      expect(maskSecrets("DB_PASS_20240115093000=hunter2xyz")).toBe(`DB_PASS_20240115093000=${M}`);
      expect(maskSecrets("| user | DbPass |\n|---|---|\n| bob | hunter2 |")).toBe(`| user | DbPass |\n|---|---|\n| bob | ${M} |`);
      expect(maskSecrets("| host | SshKey |\n|---|---|\n| h1 | AAAAC3Nza |")).toBe(`| host | SshKey |\n|---|---|\n| h1 | ${M} |`);
    });

    it("masks Azure AccountKey and *_DSN values", () => {
      expect(maskSecrets("DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=abcd1234efgh5678ijkl==;EndpointSuffix=core.windows.net")).toBe(
        `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${M};EndpointSuffix=core.windows.net`,
      );
      expect(maskSecrets("SENTRY_DSN=https://abc123def456@o12345.ingest.sentry.io/123")).toBe(`SENTRY_DSN=${M}`);
    });

    it("masks Kubernetes env values whose name is a secret, and only those", () => {
      expect(maskSecrets("- name: DB_PASSWORD\n  value: hunter2xyz")).toBe(`- name: DB_PASSWORD\n  value: ${M}`);
      expect(maskSecrets('env:\n  - name: API_TOKEN\n    value: "abcd1234efgh"')).toBe(`env:\n  - name: API_TOKEN\n    value: ${M}`);
      expect(maskSecrets("- name: \"GITHUB_TOKEN\"\n  value: 'abcd 1234'")).toBe(`- name: "GITHUB_TOKEN"\n  value: ${M}`);
      expect(maskSecrets("- name: LOG_LEVEL\n  value: debug1234")).toBe("- name: LOG_LEVEL\n  value: debug1234");
      expect(maskSecrets("- name: DB_PASSWORD\n  valueFrom:\n    secretKeyRef: x")).toBe("- name: DB_PASSWORD\n  valueFrom:\n    secretKeyRef: x");
    });

    it("masks YAML block scalars as one placeholder, keeping the lines that are indented less", () => {
      expect(maskSecrets("password: |\n  hunter2xyz")).toBe(`password: |\n  ${M}`);
      expect(maskSecrets("password: >-\n  hunter2xyz")).toBe(`password: >-\n  ${M}`);
      expect(maskSecrets("password: |\n  line one\n\n  line two\nnext: ok")).toBe(`password: |\n  ${M}\nnext: ok`);
      expect(maskSecrets("  password: |\n    a1\n    b2\n  user: bob")).toBe(`  password: |\n    ${M}\n  user: bob`);
      expect(maskSecrets("password: |\r\n  hunter2xyz\r\nuser: bob")).toBe(`password: |\r\n  ${M}\r\nuser: bob`);
      expect(maskSecrets("token: >-\n  abc\n  def\n")).toBe(`token: >-\n  ${M}\n`);
      expect(maskSecrets("description: |\n  just text here")).toBe("description: |\n  just text here");
    });

    it("masks gh secret set, openssl, ssh-keygen, aws configure set and htpasswd passwords", () => {
      expect(maskSecrets("gh secret set API_TOKEN --body abcd1234efgh")).toBe(`gh secret set API_TOKEN --body ${M}`);
      expect(maskSecrets("gh secret set API_TOKEN -b'ab cd'")).toBe(`gh secret set API_TOKEN -b${M}`);
      expect(maskSecrets("gh secret set X --body=abcd1234")).toBe(`gh secret set X --body=${M}`);
      expect(maskSecrets("gh secret set X --body-file f.txt")).toBe("gh secret set X --body-file f.txt");
      expect(maskSecrets("openssl enc -k hunter2xyz")).toBe(`openssl enc -k ${M}`);
      expect(maskSecrets("openssl rsa -passin pass:hunter2xyz -in k")).toBe(`openssl rsa -passin pass:${M} -in k`);
      expect(maskSecrets("openssl enc -passout pass:hunter2xyz")).toBe(`openssl enc -passout pass:${M}`);
      expect(maskSecrets('openssl enc -passin "pass:abc def" -in f')).toBe(`openssl enc -passin ${M} -in f`);
      expect(maskSecrets("openssl enc -k 'two words' -in f")).toBe(`openssl enc -k ${M} -in f`);
      expect(maskSecrets('openssl enc -passout "pass:abcd efgh" -out f')).toBe(`openssl enc -passout ${M} -out f`);
      expect(maskSecrets('gh secret set X --body "two words"')).toBe(`gh secret set X --body ${M}`);
      expect(maskSecrets("ssh-keygen -N hunter2xyz")).toBe(`ssh-keygen -N ${M}`);
      expect(maskSecrets("ssh-keygen -t ed25519 -N 'two words' -f k")).toBe(`ssh-keygen -t ed25519 -N ${M} -f k`);
      expect(maskSecrets("ssh-keygen -p -P old1234 -N new5678 -f k")).toBe(`ssh-keygen -p -P ${M} -N ${M} -f k`);
      expect(maskSecrets("aws configure set aws_secret_access_key abcd1234efgh5678")).toBe(`aws configure set aws_secret_access_key ${M}`);
      expect(maskSecrets("aws configure set default.aws_session_token abc123")).toBe(`aws configure set default.aws_session_token ${M}`);
      expect(maskSecrets("aws configure set region us-east-1")).toBe("aws configure set region us-east-1");
      expect(maskSecrets("htpasswd -b .htpasswd bob hunter2xyz")).toBe(`htpasswd -b .htpasswd bob ${M}`);
      expect(maskSecrets("htpasswd -bc f bob hunter2xyz")).toBe(`htpasswd -bc f bob ${M}`);
      expect(maskSecrets("htpasswd -nb bob hunter2xyz")).toBe(`htpasswd -nb bob ${M}`);
      expect(maskSecrets("htpasswd -c f bob")).toBe("htpasswd -c f bob");
    });

    it("masks a --password-stdin password given as a here-string or piped from echo", () => {
      expect(maskSecrets("docker login -u bob --password-stdin <<< S3cretPw")).toBe(`docker login -u bob --password-stdin <<< ${M}`);
      expect(maskSecrets("echo S3cretPw | docker login -u bob --password-stdin")).toBe(`echo ${M} | docker login -u bob --password-stdin`);
      expect(maskSecrets('echo "$PW" | docker login --password-stdin')).toBe('echo "$PW" | docker login --password-stdin');
      expect(maskSecrets("echo hello world")).toBe("echo hello world");
      expect(maskSecrets("echo hello123 | grep x")).toBe("echo hello123 | grep x");
    });

    it("opus kill cases: a continuation inside double quotes stays in the command, and normalizing several inputs in a row works", () => {
      expect(maskSecrets('mysql -e "select 1 \\\n; select 2" -pS3cretPw db')).toBe(`mysql -e "select 1 \\\n; select 2" -p${M} db`);
      expect(maskSecrets("ｐａｓｓｗｏｒｄ＝hunter2xyz")).toBe(`password=${M}`);
      expect(maskSecrets("x\nｐａｓｓｗｏｒｄ＝hunter2xyz")).toBe(`x\npassword=${M}`);
      expect(maskSecrets("ｐａｓｓｗｏｒｄ＝hunter2xyz")).toBe(`password=${M}`);
      expect(maskSecrets("abc")).toBe("abc");
      expect(maskSecrets("​password=abc12345")).toBe(`password=${M}`);
    });
  });

  describe("review of 9fe253ff (secrets)", () => {
    const M = SECRET_MASK;

    it("M1: htpasswd masks the last word before a redirect, skipping -C / -r values", () => {
      expect(maskSecrets("htpasswd -bBC 10 f bob hunter2xyz")).toBe(`htpasswd -bBC 10 f bob ${M}`);
      expect(maskSecrets("htpasswd -b -C 10 f bob hunter2xyz")).toBe(`htpasswd -b -C 10 f bob ${M}`);
      expect(maskSecrets("htpasswd -b -r 5000 f bob hunter2xyz")).toBe(`htpasswd -b -r 5000 f bob ${M}`);
      expect(maskSecrets("htpasswd -bn bob hunter2xyz > f")).toBe(`htpasswd -bn bob ${M} > f`);
      expect(maskSecrets("htpasswd -bn bob hunter2xyz 2>/dev/null")).toBe(`htpasswd -bn bob ${M} 2>/dev/null`);
      expect(maskSecrets("htpasswd -nb bob 'two words' >>f")).toBe(`htpasswd -nb bob ${M} >>f`);
      expect(maskSecrets('htpasswd -b f bob "a b c')).toBe(`htpasswd -b f bob ${M}`);
      expect(maskSecrets("htpasswd -b f bob hunter2xyz && echo ok")).toBe(`htpasswd -b f bob ${M} && echo ok`);
      expect(maskSecrets("htpasswd -b -- f bob hunter2xyz")).toBe(`htpasswd -b -- f bob ${M}`);
      // 多出来的参数也一起盖住（一个占位符）；有 -n 时口令是第二个位置参数。
      expect(maskSecrets("htpasswd -b f bob hunter2xyz extra")).toBe(`htpasswd -b f bob ${M}`);
      expect(maskSecrets("htpasswd -nb bob hunter2xyz extra")).toBe(`htpasswd -nb bob ${M}`);
      // 不全是字母数字的 -x.C 不是选项（是文件名），后面的 bob 不当成 -C 的值。
      expect(maskSecrets("htpasswd -b -x.C bob hunter2xyz")).toBe(`htpasswd -b -x.C bob ${M}`);
      expect(maskSecrets("htpasswd -c f bob")).toBe("htpasswd -c f bob");
      expect(maskSecrets("htpasswd -bc f")).toBe("htpasswd -bc f");
      expect(maskSecrets("htpasswd -bC 10 f bob")).toBe(`htpasswd -bC 10 f ${M}`);
    });

    it("M2: enclosed numbers, ™, ℡ and ligatures are not mapped, so they don't glue onto the next word", () => {
      expect(maskSecrets("步骤：①mysql -uroot -pHunter2xyz")).toBe(`步骤：①mysql -uroot -p${M}`);
      expect(maskSecrets("⑴mysql -pHunter2xyz")).toBe(`⑴mysql -p${M}`);
      expect(maskSecrets("⒈mysql -pHunter2xyz")).toBe(`⒈mysql -p${M}`);
      expect(maskSecrets(`①${fake.ghp}`)).toBe(`①${M}`);
      expect(maskSecrets(`①${fake.akia}`)).toBe(`①${M}`);
      expect(maskSecrets(`①${fake.ant}`)).toBe(`①${M}`);
      expect(maskSecrets(`℡${fake.ghp}`)).toBe(`℡${M}`);
      expect(maskSecrets(`ﬁ${fake.ghp}`)).toBe(`ﬁ${M}`);
      expect(maskSecrets("①key=abcdefgh12345678")).toBe(`①key=${M}`);
      expect(maskSecrets("②docker login -p S3cretPw")).toBe(`②docker login -p ${M}`);
      expect(maskSecrets("配置™Bearer abcd1234efgh5678")).toBe(`配置™${M}`);
      // 连字不展开：ﬁ 原样留着。
      expect(maskSecrets("ﬁle ﬂow")).toBe("ﬁle ﬂow");
      // 带圈、方框的单个字母照样还原（🄿🄰🅂🅂🅆🄾🅁🄳）。
      expect(maskSecrets("🄿🄰🅂🅂🅆🄾🅁🄳=hunter2xyz")).toBe(`PASSWORD=${M}`);
    });

    it("normalizes full-width text after an emoji or a lone high surrogate", () => {
      expect(maskSecrets("😀ｐａｓｓｗｏｒｄ＝hunter2xyz")).toBe(`😀password=${M}`);
      expect(maskSecrets("\ud83dｐａｓｓｗｏｒｄ＝hunter2xyz")).toBe(`\ud83dpassword=${M}`);
    });

    it("M3: masks every block scalar in a nested YAML map", () => {
      expect(maskSecrets("stringData:\n  password: |\n    hunter2xyz\n  token: |\n    s3cr3tTok\n")).toBe(
        `stringData:\n  password: |\n    ${M}\n  token: |\n    ${M}\n`,
      );
      expect(maskSecrets("password: |2\n  hunter2xyz")).toBe(`password: |2\n  ${M}`);
      expect(maskSecrets("password: |\n  a1\n\n  b2\nnext: ok")).toBe(`password: |\n  ${M}\nnext: ok`);
      expect(maskSecrets("password: |\r\n  a1  \r\n\r\nnext: ok")).toBe(`password: |\r\n  ${M}\r\n\r\nnext: ok`);
    });

    it("M4: Cookie / Set-Cookie with a full-width colon", () => {
      expect(maskSecrets("Cookie：sid=abc123; x=y")).toBe(`Cookie：${M}`);
      expect(maskSecrets("Set-Cookie：session=abcdef123; Path=/")).toBe(`Set-Cookie：${M}`);
      expect(maskSecrets("Cookie： abc123secretvalue")).toBe(`Cookie： ${M}`);
    });

    it("b: a quoted --password-stdin here-string is masked as one shell word, quotes included", () => {
      expect(maskSecrets('docker login --password-stdin <<< "hunter 2"')).toBe(`docker login --password-stdin <<< ${M}`);
      expect(maskSecrets("docker login --password-stdin <<< 'hunter2'")).toBe(`docker login --password-stdin <<< ${M}`);
      expect(maskSecrets("docker login --password-stdin <<< 'hunter 2'")).toBe(`docker login --password-stdin <<< ${M}`);
      expect(maskSecrets('docker login --password-stdin <<< "unclosed val')).toBe(`docker login --password-stdin <<< ${M}`);
    });

    it("c: a --password= value after a line continuation", () => {
      expect(maskSecrets("cli --password=\\\nab1")).toBe(`cli --password=\\\n${M}`);
      expect(maskSecrets("some-cli --password=\\\n  S3cretPw")).toBe(`some-cli --password=\\\n  ${M}`);
    });

    it("d: boundaries the mutants slipped through", () => {
      expect(maskSecrets("Authorization: abcdefgh")).toBe(`Authorization: ${M}`);
      expect(maskSecrets("Authorization: abcdefg")).toBe("Authorization: abcdefg");
      expect(maskSecrets('curl -u "admin：S3 cret" https://x')).toBe(`curl -u "admin：${M}" https://x`);
      expect(maskSecrets("aws configure set some_api_key abc")).toBe(`aws configure set some_api_key ${M}`);
      expect(maskSecrets("- name: SENTRY_DSN\n  value: https://abc@o1.ingest.sentry.io/1")).toBe(`- name: SENTRY_DSN\n  value: ${M}`);
      expect(maskSecrets("- name: DB_PASSWORD\n  value: # set later")).toBe("- name: DB_PASSWORD\n  value: # set later");
    });
  });
});

describe("review of 20531347 (secrets)", () => {
  const M = SECRET_MASK;

  it("MF1: a block scalar whose first lines are blank (spaces only, or empty) is still masked whole", () => {
    expect(maskSecrets("password: |\n  \n  Hunter2 xyz\nnext: ok")).toBe(`password: |\n  ${M}\nnext: ok`);
    expect(maskSecrets("password: |\n\n  Hunter2 xyz\nnext: ok")).toBe(`password: |\n  ${M}\nnext: ok`);
    expect(maskSecrets("password: |\n\n \t\n    Hunter2 xyz\n    line2\nnext: ok")).toBe(`password: |\n    ${M}\nnext: ok`);
    // 空行的缩进比第一个非空行深，占位符的缩进还是取第一个非空行的。
    expect(maskSecrets("password: |\n      \n  Hunter2 xyz\nnext: ok")).toBe(`password: |\n  ${M}\nnext: ok`);
    expect(maskSecrets("password: |\r\n\r\n  Hunter2 xyz\r\nnext: ok")).toBe(`password: |\r\n  ${M}\r\nnext: ok`);
    // 下面只有空行、没有值的不打。
    expect(maskSecrets("password: |\n\n\nnext: ok")).toBe("password: |\n\n\nnext: ok");
  });

  it("MF2: compat digits after a key name (subscript, superscript, math) are mapped, so the key is recognized", () => {
    expect(maskSecrets("token₁=Hunter2xyzAbc")).toBe(`token1=${M}`);
    expect(maskSecrets("password²=Hunter2xyz")).toBe(`password2=${M}`);
    expect(maskSecrets("password¹=Hunter2xyz")).toBe(`password1=${M}`);
    expect(maskSecrets("token⁴=Hunter2xyzAbc")).toBe(`token4=${M}`);
    expect(maskSecrets("𝐩𝐚𝐬𝐬𝐰𝐨𝐫𝐝𝟏=Hunter2xyz")).toBe(`password1=${M}`);
    expect(maskSecrets("𝐩𝐚𝐬𝐬𝐰𝐨𝐫𝐝𝟙=Hunter2xyz")).toBe(`password1=${M}`);
    // 带圈、带框的数字和 ™ ﬁ ℃ 不换。
    expect(maskSecrets("①⑴⒈🄁™℡ﬁ℃ ok")).toBe("①⑴⒈🄁™℡ﬁ℃ ok");
    expect(maskSecrets("步骤：①mysql -uroot -pHunter2xyz")).toBe(`步骤：①mysql -uroot -p${M}`);
    expect(maskSecrets(`🄁${fake.ghp}`)).toBe(`🄁${M}`);
  });

  it("MF4: credential / credentials keys", () => {
    expect(maskSecrets("credential=Hunter2xyz")).toBe(`credential=${M}`);
    expect(maskSecrets("credentials=Hunter2xyz")).toBe(`credentials=${M}`);
    expect(maskSecrets("credentials_prod: Hunter2xyz")).toBe(`credentials_prod: ${M}`);
    expect(maskSecrets("CREDENTIALS2=Hunter2xyz")).toBe(`CREDENTIALS2=${M}`);
  });

  it("MF4: the shared key scan is redone after a rule changes the text (positions shift)", () => {
    // 引号值先被打成占位符（长度变了），后面「token=…」的起点跟着挪了，要按新文本重扫。
    expect(maskSecrets('password: "two words here" token=Hunter2xyz')).toBe(`password: "${M}" token=${M}`);
    expect(maskSecrets("password: 'a' then token=Hunter2xyz")).toBe(`password: '${M}' then token=${M}`);
    // 中间的非 KEY 规则（Bearer）改了文本，后面的 KEY 规则也要重扫。
    expect(maskSecrets("Bearer abcdefgh12345678abcdefgh then secret is S3cr3t!x")).toBe(`${M} then secret is ${M}`);
  });

  it("1: htpasswd after --, after a continuation, and a password that starts with -", () => {
    expect(maskSecrets("htpasswd -nb -- -alice hunter2xyz")).toBe(`htpasswd -nb -- -alice ${M}`);
    expect(maskSecrets("htpasswd \\\n  -b f bob hunter2xyz")).toBe(`htpasswd \\\n  -b f bob ${M}`);
    expect(maskSecrets("htpasswd -b f bob -Hunter2xyz")).toBe(`htpasswd -b f bob ${M}`);
  });

  it("2: a here-string value is read as one shell word", () => {
    expect(maskSecrets('docker login --password-stdin <<< "hun\\"ter 2"')).toBe(`docker login --password-stdin <<< ${M}`);
    expect(maskSecrets("docker login --password-stdin <<< $'hunter 2'")).toBe(`docker login --password-stdin <<< ${M}`);
    expect(maskSecrets(`docker login --password-stdin <<< 'a'"b c"`)).toBe(`docker login --password-stdin <<< ${M}`);
    expect(maskSecrets("docker login --password-stdin <<< hunter2 && echo ok")).toBe(`docker login --password-stdin <<< ${M} && echo ok`);
    expect(maskSecrets("docker login --password-stdin <<<hunter2")).toBe(`docker login --password-stdin <<<${M}`);
  });
});

describe("review of f780e9ef (secrets)", () => {
  const M = SECRET_MASK;

  it("MF2: a run of compat digits glued to the next word stays as it is, so the word is still recognized", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(maskSecrets("注¹mysql -pHunter2xyz")).toBe(`注¹mysql -p${M}`);
    expect(maskSecrets("x²ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(`x²${M}`);
    expect(maskSecrets("𝟏AKIAABCDEFGHIJKLMNOP")).toBe(`𝟏${M}`);
    expect(maskSecrets("₂sk-abcdefghijklmnopqrstuvwxyz0123456789")).toBe(`₂${M}`);
    expect(maskSecrets("₂token is Hunter2xyz")).toBe(`₂token is ${M}`);
    expect(maskSecrets("²password is hunter2xyz")).toBe(`²password is ${M}`);
    expect(maskSecrets("注¹sshpass -p Hunter2xyz ssh h")).toBe(`注¹sshpass -p ${M} ssh h`);
    expect(maskSecrets("注¹xoxb-1234567890-abcdefghij")).toBe(`注¹${M}`);
    // JWT 整个打掉，不是只打签名。
    expect(maskSecrets(`x²${jwt}`)).toBe(`x²${M}`);
    // 一串兼容数字（₁₂）、中间隔着会被去掉的零宽字符，也按后面紧跟的字算。
    expect(maskSecrets("₁₂mysql -pHunter2xyz")).toBe(`₁₂mysql -p${M}`);
    expect(maskSecrets("₁​password is Hunter2x1")).toBe(`₁password is ${M}`);
    // 后面紧跟的是会换成字母的兼容字符（𝐩）也算紧跟字母。
    expect(maskSecrets("²𝐩𝐚𝐬𝐬𝐰𝐨𝐫𝐝 is Hunter2xyz")).toBe(`²password is ${M}`);
  });

  it("MF2: key names with a compat-digit number are still recognized", () => {
    expect(maskSecrets("token₁=Hunter2xyzAbc")).toBe(`token1=${M}`);
    expect(maskSecrets("password²: Hunter2xyz")).toBe(`password2: ${M}`);
    expect(maskSecrets("𝐩𝐚𝐬𝐬𝐰𝐨𝐫𝐝𝟏=Hunter2xyz")).toBe(`password1=${M}`);
    expect(maskSecrets("token₁₂=Hunter2xyz")).toBe(`token12=${M}`);
    expect(maskSecrets("E=mc² ok")).toBe("E=mc² ok");
  });

  it("a key=value between two masks of one command is still masked by a later KEY rule (the shared scan rescans what a rule changed)", () => {
    expect(maskSecrets("mysql -pAbc token=Hunter2xyz -pDef")).toBe(`mysql -p${M} token=${M} -p${M}`);
    expect(maskSecrets("mysql -pAbc password=Hunter2xyz -pDef ok")).toBe(`mysql -p${M} password=${M} -p${M} ok`);
    expect(maskSecrets("sshpass -p Abc token=Hunter2xyz -p Def")).toBe(`sshpass -p ${M} token=${M} -p ${M}`);
  });

  it("a key and its separator on different lines (suggestion 1, mutation M19)", () => {
    expect(maskSecrets("password\n= Hunter2xyz")).toBe(`password\n= ${M}`);
    expect(maskSecrets("密码\n是 abc12345")).toBe(`密码\n是 ${M}`);
    expect(maskSecrets("token\n  : Hunter2xyz")).toBe(`token\n  : ${M}`);
    expect(maskSecrets("password\r\n= Hunter2xyz")).toBe(`password\r\n= ${M}`);
  });

  it("text that every KEY rule rewrites, then more keys: the result is the same as running each rule on its own", () => {
    const head = `password: "a b" token is "a b" password: "abc def\ntoken is 'abc def\npassword=Hunter2xyz token is: x token is Hunter2xyz\n`;
    expect(maskSecrets(head + "pwd=Hunter2xyz, PWDS_TOKEN=Abc12345")).toBe(
      `password: "${M}" token is "${M}" password: "${M}\ntoken is '${M}\npassword=${M} token is: ${M} token is ${M}\npwd=${M}, PWDS_TOKEN=${M}`,
    );
  });
});

describe("review of c067e822 (secrets)", () => {
  const M = SECRET_MASK;

  it("must-fix 2: a key name, then compat digits, then a suffix is still a key (the digits map after a key name)", () => {
    expect(maskSecrets("token₁_prod=Hunter2xyz")).toBe(`token1_prod=${M}`);
    expect(maskSecrets("PASSWORD²_DB=Hunter2xyz")).toBe(`PASSWORD2_DB=${M}`);
    expect(maskSecrets("api_key²_live=Hunter2xyz")).toBe(`api_key2_live=${M}`);
    expect(maskSecrets("password²abc=Hunter2xyz")).toBe(`password2abc=${M}`);
    expect(maskSecrets("token₁s=Hunter2xyz")).toBe(`token1s=${M}`);
    expect(maskSecrets("token₁2=Hunter2xyz")).toBe(`token12=${M}`);
    expect(maskSecrets("token₁ᵃ=Hunter2xyz")).toBe(`token1a=${M}`);
    expect(maskSecrets("𝐭𝐨𝐤𝐞𝐧𝟏𝐱=Hunter2xyz")).toBe(`token1x=${M}`);
    expect(maskSecrets("𝐭𝐨𝐤𝐞𝐧𝟏_𝐩𝐫𝐨𝐝=Hunter2xyz")).toBe(`token1_prod=${M}`);
    // 键名带编号以后再跟兼容数字；复数的键名。
    expect(maskSecrets("token_1²_prod=Hunter2xyz")).toBe(`token_12_prod=${M}`);
    expect(maskSecrets("tokens₁_prod=Hunter2xyz")).toBe(`tokens1_prod=${M}`);
    // 往回看的键名按换完以后算：全角的、中间夹零宽字符的。
    expect(maskSecrets("ｔｏｋｅｎ₁_prod=Hunter2xyz")).toBe(`token1_prod=${M}`);
    expect(maskSecrets("tok\u200ben₁_prod=Hunter2xyz")).toBe(`token1_prod=${M}`);
  });

  it("must-fix 2: an ENV-style key (…_SECRET, …_TOKEN, …_KEY), then compat digits, then a suffix", () => {
    expect(maskSecrets("MY_SECRET²_X=Hunter2xyz")).toBe(`MY_SECRET2_X=${M}`);
    expect(maskSecrets("GITHUB_TOKEN₁_CI=Hunter2xyz")).toBe(`GITHUB_TOKEN1_CI=${M}`);
    expect(maskSecrets("STRIPE_KEY²_LIVE=Hunter2xyz")).toBe(`STRIPE_KEY2_LIVE=${M}`);
    // ENV 式只认大写：小写的 primary_key 不在键名里，数字不换，后面的 ghp_ 照常认得出。
    expect(maskSecrets("primary_key²ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(`primary_key²${M}`);
  });

  it("must-fix 2: zero-width characters and soft hyphens inside a run of compat digits do not split it", () => {
    expect(maskSecrets("token₁\u200b₂=Hunter2xyz")).toBe(`token12=${M}`);
    expect(maskSecrets("password²\u200b³: Hunter2xyz")).toBe(`password23: ${M}`);
    expect(maskSecrets("𝐩𝐚𝐬𝐬𝐰𝐨𝐫𝐝𝟏\u200b𝟐=Hunter2xyz")).toBe(`password12=${M}`);
    expect(maskSecrets("token₁\u00ad₂=Hunter2xyz")).toBe(`token12=${M}`);
    expect(maskSecrets("token₁\u{E0001}₂=Hunter2xyz")).toBe(`token12=${M}`);
    // 一整串（不是只到零宽字符为止）后面不紧跟字母数字，就整串都换：ghp_ 后面接着的 12 还是这个令牌的一部分。
    expect(maskSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123456789₁\u200b₂ ok")).toBe(`${M} ok`);
    expect(maskSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123456789₁\u{E0001}₂ ok")).toBe(`${M} ok`);
    // 不是键名的前面：整串都不换，夹在中间的不可见字照常去掉。
    expect(maskSecrets("x₁\u200b₂ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(`x₁₂${M}`);
  });

  it("must-fix 2: digits glued to a word after something that is not a key name still stay as they are", () => {
    expect(maskSecrets("x²ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(`x²${M}`);
    expect(maskSecrets("注¹mysql -pHunter2xyz")).toBe(`注¹mysql -p${M}`);
    // 键名只是前文的一部分时（monkey 里的 key 不在键名里；passwordless 后面不是键名结尾）也不换。
    expect(maskSecrets("passwordless²ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(`passwordless²${M}`);
  });

  it("suggestion 2: what follows the digits is judged after mapping, skipping ignorable astral characters (N3, N5, N6, N7)", () => {
    // N3：全角的字母。
    expect(maskSecrets("x²ｇｈｐ_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(`x²${M}`);
    expect(maskSecrets("注¹ｍｙｓｑｌ -pHunter2xyz")).toBe(`注¹mysql -p${M}`);
    // N5：后面紧跟的是 _。
    expect(maskSecrets("x²_token is Hunter2xyz")).toBe(`x²_token is ${M}`);
    // N6：带圈字母换成字母，也算紧跟字母。
    expect(maskSecrets("注¹ⓜysql -pHunter2xyz")).toBe(`注¹mysql -p${M}`);
    // N7：中间隔一个 BMP 以外的可忽略字（U+E0001）。
    expect(maskSecrets("注¹\u{E0001}mysql -pHunter2xyz")).toBe(`注¹mysql -p${M}`);
    expect(maskSecrets("x²\u{E0001}ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(`x²${M}`);
  });

  it("suggestion 1 (E9): an upper-case key between two masks of one command is masked (the rescan ignores case)", () => {
    expect(maskSecrets("mysql -pAbc TOKEN=Hunter2xyz -pDef")).toBe(`mysql -p${M} TOKEN=${M} -p${M}`);
    expect(maskSecrets("mysql -pAbc Password=Hunter2xyz -pDef")).toBe(`mysql -p${M} Password=${M} -p${M}`);
  });

  it("must-fix 1: values starting with [R, before and after other keys, give the same result as running each rule on its own", () => {
    expect(maskSecrets("password=[Rabc123 token=Hunter2xyz")).toBe(`password=${M} token=${M}`);
    expect(maskSecrets("mysql -p[Rxyz ok token=Hunter2xyz -p[Rq")).toBe(`mysql -p${M} ok token=${M} -p${M}`);
    expect(maskSecrets('password: "[Rxx" pwd=Hunter2xyz')).toBe(`password: "${M}" pwd=${M}`);
  });
});

describe("review of adf2412e (secrets)", () => {
  const M = SECRET_MASK;

  it("must-fix B: after a key name, compat digits glued to another secret pattern stay as they are (the pattern still starts a word)", () => {
    expect(maskSecrets(`token²${fake.ghp}`)).toBe(`token²${M}`);
    expect(maskSecrets("password¹mysql -pHunter2xyz")).toBe(`password¹mysql -p${M}`);
    expect(maskSecrets(`token₁${fake.akia}`)).toBe(`token₁${M}`);
    expect(maskSecrets(`secret²${fake.sk}`)).toBe(`secret²${M}`);
    expect(maskSecrets(`password²${fake.slack}`)).toBe(`password²${M}`);
    expect(maskSecrets(`pwd²${fake.npm}`)).toBe(`pwd²${M}`);
    expect(maskSecrets(`passwords¹${fake.ghp}`)).toBe(`passwords¹${M}`);
    expect(maskSecrets(`the token²${fake.ghp} leaked`)).toBe(`the token²${M} leaked`);
  });

  /**
   * 没有要打码的就原样返回，看不出数字换没换：反例后面都接一个要打码的 token=…，换了的话整行会是换过的那一份。
   * 这些例子里兼容数字后面都紧跟字母、数字或 _（只有这种才要判换完是不是键；后面是 =、-、空白的照换）。
   */
  const T = " token=Hunter2xyz";
  const kept = (s: string): void => expect(maskSecrets(s + T), s).toBe(`${s} token=${M}`);

  it("must-fix B: both readings are masked: mapping the digits gives a key, and the key's value is masked", () => {
    // 数字前面隔着很长一串编号（以前往回只看 40 个字，整个漏掉）。
    expect(maskSecrets(`token_${"1234567890".repeat(4)}₁_prod=Hunter2xyz`)).toBe(`token_${"1234567890".repeat(4)}1_prod=${M}`);
    expect(maskSecrets(`token${"1".repeat(70)}x₁y= Hunter2xyz`)).toBe(`token${"1".repeat(70)}x1y= ${M}`);
    // 键名中间夹一大片零宽字符（去掉的字不算往回看的步数）。
    const zw = "​".repeat(70);
    expect(maskSecrets(`tok${zw}en₁_prod= Hunter2xyz`)).toBe(`token1_prod= ${M}`);
    expect(maskSecrets(`key${zw}₁_= Hunter2xyz`)).toBe(`key1_= ${M}`);
    expect(maskSecrets(`k${zw}ey₁_= Hunter2xyz`)).toBe(`key1_= ${M}`);
    // 长键名（往回看得够远：S2）、键名带编号再跟兼容数字（S17）。
    expect(maskSecrets("private_key₁_prod=Hunter2xyz")).toBe(`private_key1_prod=${M}`);
    expect(maskSecrets("authentication_string²_x=Hunter2xyz")).toBe(`authentication_string2_x=${M}`);
    expect(maskSecrets("MY_API_KEY_2²_X=Hunter2xyz")).toBe(`MY_API_KEY_22_X=${M}`);
    // 编号前面的 _ 或 -、名字和编号之间的 _（token_12_₁x）、编号后面直接是 - 开头的后缀。
    expect(maskSecrets("token_²_prod=Hunter2xyz")).toBe(`token_2_prod=${M}`);
    expect(maskSecrets("token_12_₁x= Hunter2xyz")).toBe(`token_12_1x= ${M}`);
    expect(maskSecrets("token12-a₁b= Hunter2xyz")).toBe(`token12-a1b= ${M}`);
    expect(maskSecrets("token12-₁b= Hunter2xyz")).toBe(`token12-1b= ${M}`);
    // 后缀后面的 KQ：_ _、**、引号。
    expect(maskSecrets("token₁__: Hunter2xyz")).toBe(`token1__: ${M}`);
    expect(maskSecrets("token₁_prod**: Hunter2xyz")).toBe(`token1_prod**: ${M}`);
    expect(maskSecrets('pwd₁_X"= Hunter2xyz')).toBe(`pwd1_X"= ${M}`);
    // 「 is」、是、为、全角冒号。
    expect(maskSecrets("token₁_prod is Hunter2xyz")).toBe(`token1_prod is ${M}`);
    expect(maskSecrets("pwd₁_X 是 Hunter2xyz")).toBe(`pwd1_X 是 ${M}`);
    expect(maskSecrets("pwd₁_X为Hunter2xyz")).toBe(`pwd1_X为${M}`);
    expect(maskSecrets("pwd₁_prod： Hunter2xyz")).toBe(`pwd1_prod： ${M}`);
    // 键和分隔符之间的空白多长都行（和 KEY 里的 \s* 一样）。
    const gap = " ".repeat(100);
    expect(maskSecrets(`token₁_prod${gap}= Hunter2xyz`)).toBe(`token1_prod${gap}= ${M}`);
    expect(maskSecrets(`token₁_${gap}= Hunter2xyz`)).toBe(`token1_${gap}= ${M}`);
    expect(maskSecrets(`key₁_${gap}= Hunter2xyz`)).toBe(`key1_${gap}= ${M}`);
    expect(maskSecrets(`tokenmonkey₁x${gap}= Hunter2xyz`)).toBe(`tokenmonkey1x${gap}= ${M}`);
  });

  it("must-fix B: compat digits inside a key's word suffix map too (the suffix may contain digits)", () => {
    expect(maskSecrets("tokenmonkey₁x=Hunter2xyz")).toBe(`tokenmonkey1x=${M}`);
    expect(maskSecrets("tokens₁ᵃ=Hunter2xyz")).toBe(`tokens1a=${M}`);
    expect(maskSecrets("token2x₁y=Hunter2xyz")).toBe(`token2x1y=${M}`);
    expect(maskSecrets("token12_₁x=Hunter2xyz")).toBe(`token12_1x=${M}`);
    // 后缀最多 16 个字母数字（编号后面的、字母开头的、后缀里夹着数字的）：16 个的换、17 个的不换（换了也不是键）。
    expect(maskSecrets("token₁_abcdefghijklmnop= Hunter2xyz")).toBe(`token1_abcdefghijklmnop= ${M}`);
    expect(maskSecrets("secret₁abcdefghijklmnop: Hunter2xyz")).toBe(`secret1abcdefghijklmnop: ${M}`);
    expect(maskSecrets("token_abcdefghijklmn₁o=Hunter2xyz")).toBe(`token_abcdefghijklmn1o=${M}`);
    expect(maskSecrets("tokenabcdefghijklmn₁o=Hunter2xyz")).toBe(`tokenabcdefghijklmn1o=${M}`);
    kept("token₁_abcdefghijklmnopq= Hunter2xyz");
    kept("token₁abcdefghijklmnopq= Hunter2xyz");
    kept("token_abcdefghijklmno₁p= Hunter2xyz");
    kept("tokenabcdefghijklmno₁p= Hunter2xyz");
    // tokens 再加一个 s 起头的 17 个字：后缀只能从第二个 s 起，太长。
    kept("tokenss²abcdefghijklmno ： Hunter2xyz");
  });

  it("must-fix B: compat digits in a bare key, an ENV-style key, or a table key cell", () => {
    expect(maskSecrets("key₁_=Hunter2xyz")).toBe(`key1_=${M}`);
    expect(maskSecrets("the KEY_₁_:Hunter2xyz")).toBe(`the KEY_1_:${M}`);
    // 单独的 key 前面不能连着字母、数字、_；后面直接是分隔符（不能再跟后缀）。
    kept("monkey₁_= Hunter2xyz");
    kept("My_key₁_ = Hunter2xyz");
    kept("KEY²x“\t: Hunter2xyz");
    // ENV 式：数字在前缀里、在后缀里；整段要从词头起、全是大写，后面只能是冒号、等号。
    expect(maskSecrets("MY₁_TOKEN=Hunter2xyz")).toBe(`MY1_TOKEN=${M}`);
    expect(maskSecrets("ＭＹ₁_ＴＯＫＥＮ＝Hunter2xyz")).toBe(`MY1_TOKEN=${M}`);
    expect(maskSecrets("MY_TOKEN_X₁Y=Hunter2xyz")).toBe(`MY_TOKEN_X1Y=${M}`);
    expect(maskSecrets("A_KEY₁_X=Hunter2xyz")).toBe(`A_KEY1_X=${M}`);
    kept("a_KEY₁_X=Hunter2xyz");
    kept("_KEY₁_X=Hunter2xyz");
    kept("MY_KEY₁_' 是 Hunter2xyz");
    // 表格：| 键 | 值 |（键和 | 之间只能是空格、制表符）。
    expect(maskSecrets("| token₁_prod | Hunter2xyz |")).toBe(`| token1_prod | ${M} |`);
    kept("secret-₁x　| Hunter2xyz");
  });

  it("suggestion S10: an astral ignorable inside a run of compat digits before a token does not join them to it", () => {
    expect(maskSecrets(`x₁\u{E0001}₂${fake.ghp}`)).toBe(`x₁₂${M}`);
  });

  it("must-fix B: what follows a key name but is not a separator keeps the digits as they are", () => {
    kept("token₁_-: Hunter2xyz");
    kept("token₁_x-: Hunter2xyz");
    kept('pwd₁_x""=Hunter2xyz');
    kept("token₁_x it Hunter2xyz");
    kept("secret²x__is  Hunter2xyz");
    kept("pwd₁y_Z_ 为 Hunter2xyz");
    // 键名后面多了一个 _ 或 -（token_-a…）、两个 _（pwd_-x…）：不是「键名 [_-]? 编号」。
    kept("token_-a₁b= Hunter2xyz");
    kept("pwd_-x₁y= Hunter2xyz");
  });
});
