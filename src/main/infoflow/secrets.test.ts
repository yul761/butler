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

  it("stays linear on adversarial input: a few hundred KB runs in under 100ms", () => {
    // 单独跑最慢的约 25ms；全量测试并行跑时机器忙，会翻倍。平方级的（注释里记的那些）都在 500ms 以上，100ms 照样拦得住。
    const LIMIT_MS = 100;
    const N = 200_000;
    const inputs = {
      urls: "://a:".repeat(N / 5),
      isSpaces: "token is" + " ".repeat(N) + "x",
      isSpacesColon: "the password is" + " ".repeat(N) + ":",
      docker: "docker login ".repeat(N / 13),
      mysql: "mysql ".repeat(N / 6),
      quoted: 'password: "' + "a".repeat(N),
      quotedMix: ('token="' + "a".repeat(20) + "token='").repeat(N / 40),
      keys: "token=".repeat(N / 6),
      keySpaces: "token" + " ".repeat(N),
      envKey: "A_".repeat(N / 2),
      b64: "aA1".repeat(N / 3),
      hex: "a1".repeat(N / 2) + "g",
      cookies: "Cookie: ".repeat(N / 8),
      dashU: "-u" + " ".repeat(N),
      bareKey: 'key: "'.repeat(N / 6),
      paths: "a/".repeat(N / 2),
      cookieNoSpace: "Cookie:".repeat(N / 7),
      setCookie: "Set-Cookie:a".repeat(N / 12),
      cookieDigits: "Cookie: a1".repeat(N / 10),
      urlWindow: ("://".repeat(300) + " aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW/xY1zA2 ").repeat(N / 940),
      sshpass: "sshpass ".repeat(N / 8),
      mysqlDashP: "mysql" + " -p".repeat(N / 3),
      dockerLogin: "docker login".repeat(N / 12),
      query: "?code=".repeat(N / 6),
      slack: "hooks.slack.com/services/".repeat(N / 25),
      // 第五轮：每个长串前面都要往回走一段的输入（以前 8 次 lastIndexOf × 2048 字）。
      b64Comma: ("aB3dE5fG7hJ9kL1mN3pQ5rS7tU9v/xY1" + ",").repeat(N / 33),
      jsonPaths: '"src/Main/Component12345678/IndexAbc",'.repeat(N / 38),
      urlNoCut: ("://".repeat(80) + "Abcdefghijklmn1/Abcdefghijklmn2/Abcdefghijklmn3,").repeat(N / 288),
      mysqlQuotes: "mysql " + "'a".repeat(N / 2),
      mysqlSemis: "mysql x;".repeat(N / 8),
      mysqlMixedQuotes: "mysql " + "\"'".repeat(N / 2),
      unclosed: 'password: "' + "a ".repeat(N / 2),
      unclosedMix: ('password: "' + "password: '").repeat(N / 22),
      unclosedBt: "token=`".repeat(N / 7),
      queryLong: "?code=" + "a".repeat(N),
      // 第七轮：全角的开引号和闭引号不是同一个字，每个开引号都不能扫到行尾再失败。
      fullWidthOpen: "token:“".repeat(N / 7),
      fullWidthOpenSingle: "密码：‘".repeat(N / 3),
      fullWidthClosedAtEnd: "token:“".repeat(N / 7) + "”",
      fullWidthKey: "key=“".repeat(N / 5),
      fullWidthIs: "token is “".repeat(N / 10),
      fullWidthTable: "|password|“".repeat(N / 11),
      fullWidthEnv: "A_KEY“:‘".repeat(N / 8),
      cornerOpen: "密码：「".repeat(N / 4),
      cornerOpenDouble: "token=『".repeat(N / 7),
      unclosedEscapes: 'password: "' + '\\"'.repeat(N / 2),
      unclosedSingleEscapes: "password: '" + "\\'".repeat(N / 2),
      apostrophes: "password: " + "a'".repeat(N / 2),
      italicKeys: "*password*".repeat(N / 10),
      mysqlConcat: "mysql -p" + "'a'b".repeat(N / 4),
      mysqlOpenWalk: ("mysql's -p'a;" + "b'c".repeat(20)).repeat(N / 73),
      tableRows: "| user | password |\n|---|---|\n" + "| a | b |\n".repeat(N / 10),
      tablePipes: "|".repeat(N),
      tableRules: "|---|\n".repeat(N / 6),
      tableEscapes: "| password |\n|---|\n" + "\\|".repeat(N / 2),
      // 第八轮：表头有很多密钥列、下面很多短行（以前每行都把所有列走一遍，200KB 约 500ms）。
      tableWideHeader: "|key".repeat(N / 5) + "\n|-\n" + "|\n".repeat(N / 20),
      tableHeaderEveryRow: ("|password".repeat(500) + "\n|-\n").repeat(N / 4503),
      quotesInValue: "password: a" + "'!".repeat(N / 2),
      pEscapes: "mysql -p" + "\\ ".repeat(N / 2),
      tableLongHeader: "| " + "a_".repeat(N / 2) + " |\n|---|\n| x |",
      mysqlRuleRows: "| password |\n" + "+-+\n| a |\n".repeat(N / 10),
      crTable: "| password |\r|-|\r" + "| a |\r".repeat(N / 6),
      emptyQuotes: "password: " + '""'.repeat(N / 2),
      // 第九轮：一行很长的 +----…----| 跟在表格行下面（以前 MYSQL_RULE 的 [+:-]*-[+:-]* 平方级回溯，200KB 41s）。
      // 末尾不加「中」也要跑：加了它这行就不是分隔行，碰不到那条正则。
      longMysqlRule: "| a |\n|-|\n| x |\n+" + "-".repeat(N) + "|\n",
      // 表头格子到 128 字为止：很多个 126 字的格子，每格都要试一遍（HEADER_KEY 在格子里是平方级的，限长才线性）。
      // 超过 128 字的格子不当表头：限长放宽到一千字以上，这个输入就是平方级。
      headerCellsOverCap: "| a |\n|-|\n" + ("|" + "a_".repeat(500)).repeat(N / 1001) + "\n|-|\n",
      headerCellsAtCap: "| a |\n|-|\n" + ("|" + "a_".repeat(63) + "\n|-|\n").repeat(N / 132),
      // 第九轮建议：前面没有开引号的值里，引号后面跟着 ) ] } > 的要往后看；闭引号后面接着打；驼峰表头；grid 表格的 +===+；* 后面的 hex。
      bareQuoteBrackets: "password: a" + "')".repeat(N / 2),
      bareLongBrackets: "password: a'" + ")".repeat(N),
      bareManyKeys: ("password: a'" + ")".repeat(50) + " ").repeat(N / 63),
      tailQuotes: "password: 'a'" + '"'.repeat(N),
      tailApostrophes: "password: 'a'" + "x'".repeat(N / 2),
      tailMany: "password: 'a'\"".repeat(N / 14),
      camelHeader: ("|" + "aB".repeat(60)).repeat(N / 121) + "\n|-|\n| x |",
      gridRules: "| password |\n" + "+=+\n".repeat(N / 4),
      starHex: "*a1".repeat(N / 3),
      // 第十轮：很宽的表头（几万个密钥列）下面很多短的键名行、每行下面跟着分隔行：以前每行都把整个列表重建再排序，200KB 约 8s。
      wideHeaderMerge: "|key".repeat(N / 8) + "\n|-\n" + "|key\n|-\n".repeat(N / 16),
      wideHeaderMergeOdd: "|key|x".repeat(N / 12) + "\n|-\n" + "|x|key\n|-\n".repeat(N / 22),
      // 每行多一格、下面都跟着分隔行：每行的每一格都要当表头试一遍（空格子要跳过，不然约 30ms）。
      growingRows: Array.from({ length: 630 }, (_, k) => "|".repeat(k + 1) + "key\n|-\n").join(""),
      shortCellsEveryRow: ("|a".repeat(300) + "\n|-\n").repeat(N / 604),
      // 第十轮建议：键名带数字编号、全大写 / 全小写连写的表头、pass word、闭引号后的反引号和全角引号、「is」后面的空引号、
      // 空引号后面没有开引号的值、\ 续行的命令。
      keyDigits: "password" + "1".repeat(N),
      keyDigitsMany: "password1".repeat(N / 9),
      envDigits: "A_KEY_" + "1".repeat(N),
      envDigitsMany: "A_KEY_1".repeat(N / 7),
      keyNumbered: "key" + "1".repeat(N) + "=",
      tableDigits: "| token" + "1".repeat(N) + " | ",
      runHeader: ("|" + "dbx".repeat(42) + "\n|-|\n").repeat(N / 132),
      runHeaderUpper: ("|" + "DBPASS".repeat(21)).repeat(N / 127) + "\n|-|\n| x |",
      passWordHeader: "|pass word".repeat(N / 10) + "\n|-|\n| x |",
      passHeaderRun: ("|" + "pass_".repeat(25) + "\n|-|\n").repeat(N / 130),
      tailBackticks: "password: 'a'" + "`".repeat(N),
      tailFwOpen: "password: 'a'" + "“".repeat(N / 2) + "‘".repeat(N / 2),
      tailFwPairs: "password: 'a'" + "「x」".repeat(N / 3),
      tailManyFw: "password: 'a'『".repeat(N / 14),
      isEmptyPairs: 'the password is "" '.repeat(N / 19),
      isEmptySpaces: 'the password is ""' + " ".repeat(N) + "x",
      isColonEmpty: 'password is: ""'.repeat(N / 15),
      bareAfterPair: "password: ''a')".repeat(N / 15),
      bareAfterPairRun: "password: ''a" + "')".repeat(N / 2),
      pairRun: "password: " + "'".repeat(N),
      cmdContinued: "mysql " + "\\\n".repeat(N / 2),
      cmdContinuedMany: "mysql -pa \\\n".repeat(N / 12),
      cmdContinuedCrlf: "mysql -p" + "\\\r\n".repeat(N / 3),
    };
    // 取最好的一次，最多跑 5 次、一次够快就停。
    const time = (input: string): number => {
      let best = Infinity;
      for (let i = 0; i < 5 && best >= LIMIT_MS; i++) {
        const t = performance.now();
        maskSecrets(input);
        best = Math.min(best, performance.now() - t);
      }
      return best;
    };
    // 每个输入末尾都加一个「中」（串里有非 Latin1 的字时，带 i 标志的反向引用每个字慢十倍），再跑一次双字节版本。
    const wide = (s: string): string => s.replace(/a/g, "。").replace(/ /g, "　");
    // 第十轮：再跑两种全角引号的版本（ASCII 引号换成开引号“‘、闭引号”’）。
    const fwOpen = (s: string): string => s.replace(/"/g, "“").replace(/'/g, "‘");
    const fwClose = (s: string): string => s.replace(/"/g, "”").replace(/'/g, "’");
    for (const [name, input] of Object.entries(inputs)) {
      expect(time(input + "中"), name).toBeLessThan(LIMIT_MS);
      expect(time(wide(input) + "中"), `${name} (双字节)`).toBeLessThan(LIMIT_MS);
      expect(time(fwOpen(input) + "中"), `${name} (全角引号“‘)`).toBeLessThan(LIMIT_MS);
      expect(time(fwClose(input) + "中"), `${name} (全角引号”’)`).toBeLessThan(LIMIT_MS);
    }
    // 第六轮：三种引号的值都没闭合，后面跟着二十万个双字节字（以前 52ms，Windows 约 100ms）。
    for (const fill of ["。", "　", "中"]) {
      const input = "DB_PASSWORD=`x DB_PASSWORD='x DB_PASSWORD=\"x key=`x key='x key=\"x token is `x token is 'x" + fill.repeat(N);
      expect(time(input), fill).toBeLessThan(LIMIT_MS);
    }
    // 只有一个没闭合的值、后面两百万个双字节字：每条规则只扫一遍，反向引用的慢法在这里才显出来（以前 200ms 以上）。
    for (const head of ['password: "x', "DB_PASSWORD=`x", "API_KEY='x"]) {
      expect(time(head + "中".repeat(2_000_000)), head).toBeLessThan(LIMIT_MS);
    }
    // 第十轮加的规则：一个前缀后面两百万个字，几种填充字都跑一遍。表格那个前缀不配带换行的填充：一百万行光是按行切开就要
    // 约 60ms（线性，改动前也一样，200KB 时 6ms），多行的表格由上面 200KB 的输入管。
    for (const head of ["password", "A_KEY_", "password: 'a'", "the password is \"\" ", "password: ''a", "mysql -p", "mysql ", "| DBPASSWORD |\n|-|\n"]) {
      for (const fill of ["中", "1", "`", "“", "\\\n", "')"]) {
        if (head.startsWith("|") && fill.includes("\n")) continue;
        expect(time(head + fill.repeat(2_000_000 / fill.length)), `${head} + ${JSON.stringify(fill)}`).toBeLessThan(LIMIT_MS);
      }
    }
   }, 30_000);

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
    // 大小写混着、拆开后没有键名的照旧不算（Tokenizer、Secretary、Passenger）；连写的规则不认 key、pass（monkey、passenger）。
    for (const h of ["Tokenizer", "Secretary", "Passenger", "monkey", "passenger", "KEYSTONE", "BYPASS"]) {
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
  });
});
