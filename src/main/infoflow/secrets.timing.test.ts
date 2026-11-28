import { describe, expect, it, vi } from "vitest";
import { maskSecrets } from "./secrets";
/*
 * 计时：合约是 200KB 下 50ms，超过 35ms 就算危险。平方级的（注释里记的那些）在 200KB 下都是几百 ms 到几秒。
 * 抖动这样压：每个输入先不计时跑一遍（正则按输入的字节宽度分别编译），再跑三次取最好的。这个文件在 vitest.config.mts 里
 * 单独一个 project（timing）：排在别的测试全跑完以后、只用一个 worker，不和并行的测试抢 CPU（vitest 5 没有 describe.sequential，
 * 同一个文件里的用例本来就是一个接一个跑的；抖动来自别的文件的 worker）。
 */
describe("maskSecrets stays linear on adversarial input (BTL-272: 200KB in under 50ms)", () => {
  const LIMIT_MS = 50;
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
    // 复核 fed50a04：Authorization 的任意 scheme、续行、引号里带空格的命令行值、pass / pin、驼峰键名、k8s env、YAML 块标量、
    // gh secret set / openssl / ssh-keygen / aws configure set / htpasswd、--password-stdin。
    authz: "Authorization: ".repeat(N / 15),
    authzScheme: "Authorization: a ".repeat(N / 17),
    authzQuoted: "Authorization=\"".repeat(N / 15),
    contKey: "password=\\\n".repeat(N / 11),
    contCli: " --token=\\\n".repeat(N / 11),
    contUser: " -u a:\\\n".repeat(N / 8),
    cliUserDq: ' -u "'.repeat(N / 5),
    cliUserSq: " -u '".repeat(N / 5),
    cliUserDqNoColon: ' -u "' + "a".repeat(N),
    cliSecretDq: ' --password "'.repeat(N / 13),
    cliSecretSq: " --token '".repeat(N / 10),
    passKeys: "pass: ".repeat(N / 6),
    pinKeys: '"pin": "'.repeat(N / 8),
    camelKeys: "passwordHash".repeat(N / 12),
    camelDigits: "token" + "1a".repeat(N / 2),
    k8sNames: "- name: DB_PASSWORD\n  value: ".repeat(N / 30),
    k8sPlainNames: "name: a\nvalue: ".repeat(N / 16),
    k8sLongName: "name: " + "a".repeat(N),
    yamlBlocks: "password: |\n ".repeat(N / 14),
    yamlBlockLines: "password: |\n" + "  a\n".repeat(N / 4),
    yamlBlockDedent: "password: |\n" + "  a\n a\n".repeat(N / 7),
    ghSecret: "gh secret set ".repeat(N / 14),
    ghSecretBody: "gh secret set x -b".repeat(N / 18),
    openssl: "openssl -k ".repeat(N / 11),
    opensslPassin: "openssl -passin pass:".repeat(N / 21),
    sshKeygen: "ssh-keygen -N ".repeat(N / 14),
    awsSet: "aws configure set ".repeat(N / 18),
    awsKeyWord: "aws configure set " + "key".repeat(N / 3),
    awsLongWord: "aws configure set " + "a".repeat(N),
    htpasswd: "htpasswd -b ".repeat(N / 12),
    htpasswdWords: "htpasswd -b" + " a".repeat(N / 2),
    htpasswdFlags: "htpasswd -b" + " -a".repeat(N / 3),
    stdinMany: "--password-stdin ".repeat(N / 17),
    stdinSpaces: "--password-stdin" + " ".repeat(N) + "<<<",
    echoMany: "echo a ".repeat(N / 7),
    echoPipes: "echo a | ".repeat(N / 9),
  };
  const time = (input: string): number => {
    maskSecrets(input);
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
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
  // 第十一轮：走规范化的版本（开头一个零宽空格；a、=、| 换成全角和框线），每行都要先规范化再打码。
  const zw = (s: string): string => "\u200b" + s;
  const fullwidth = (s: string): string => s.replace(/a/g, "ａ").replace(/=/g, "＝").replace(/\|/g, "│");

  it.each(Object.entries(inputs))("%s, plain and double-byte", (name, input) => {
    expect(time(input + "中"), name).toBeLessThan(LIMIT_MS);
    expect(time(wide(input) + "中"), `${name} (双字节)`).toBeLessThan(LIMIT_MS);
  });

  it.each(Object.entries(inputs))("%s, full-width quotes", (name, input) => {
    expect(time(fwOpen(input) + "中"), `${name} (全角引号“‘)`).toBeLessThan(LIMIT_MS);
    expect(time(fwClose(input) + "中"), `${name} (全角引号”’)`).toBeLessThan(LIMIT_MS);
  });

  it.each(Object.entries(inputs))("%s, through the normalizing path", (name, input) => {
    expect(time(zw(input) + "中"), `${name} (零宽)`).toBeLessThan(LIMIT_MS);
    expect(time(fullwidth(input) + "中"), `${name} (全角、框线)`).toBeLessThan(LIMIT_MS);
  });

  it("unclosed quoted values followed by 200KB of double-byte characters", () => {
    // 第六轮：三种引号的值都没闭合，后面跟着二十万个双字节字（以前 52ms，Windows 约 100ms）。
    for (const fill of ["。", "　", "中"]) {
      const input = "DB_PASSWORD=`x DB_PASSWORD='x DB_PASSWORD=\"x key=`x key='x key=\"x token is `x token is 'x" + fill.repeat(N);
      expect(time(input), fill).toBeLessThan(LIMIT_MS);
    }
    // 只有一个没闭合的值、后面全是双字节字：每条规则只扫一遍，反向引用的慢法在这里显出来。
    for (const head of ['password: "x', "DB_PASSWORD=`x", "API_KEY='x"]) {
      expect(time(head + "中".repeat(N)), head).toBeLessThan(LIMIT_MS);
    }
  });

  it("one prefix followed by 200KB of one filler", () => {
    for (const head of ["password", "A_KEY_", "password: 'a'", "the password is \"\" ", "password: ''a", "mysql -p", "mysql ", "| DBPASSWORD |\n|-|\n", "ｐａｓｓｗｏｒｄ＝",
      "Authorization: ", "password: |\n", "- name: DB_PASSWORD\n  value: ", " -u \"a:", " --password \"", "pass: ", "htpasswd -b",
      "aws configure set ", "echo ", "--password-stdin", "gh secret set x --body ", "password=\\\n"]) {
      for (const fill of ["中", "1", "`", "“", "\\\n", "')", "A_", "\u200b", "│"]) {
        expect(time(head + fill.repeat(N / fill.length)), `${head} + ${JSON.stringify(fill)}`).toBeLessThan(LIMIT_MS);
      }
    }
  });

  it("checks each non-empty header cell once, skipping the empty ones", () => {
    // 很多空格子的表头：空格子不跑表头正则（以前每格都跑两三条，200KB 约 30ms；计时拦不住，这里数调用次数）。
    const spy = vi.spyOn(RegExp.prototype, "test");
    try {
      maskSecrets("|".repeat(5000) + "key\n|-|\n| v4lue |");
      expect(spy.mock.calls.length).toBeLessThan(500);
    } finally {
      spy.mockRestore();
    }
  });
});
