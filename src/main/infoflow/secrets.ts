/**
 * 信息流转（BTL-272）：要点里不能带密钥。对话里贴过的 token、密码、私钥，模型抽要点时可能原样抄进 text / quote，
 * 一旦写进记忆、发进信箱、存进库、发到 PR 评论，就会被之后每个 session 读到。写出去之前一律打码。
 *
 * 规则按顺序替换。整段匹配的（表头表格里的整格、私钥块从 BEGIN 到 END）排在最前面：先整段换成一个占位符，后面的规则不会把它拆成几段、漏下中间的字。
 * 占位符本身不会被后面的规则再匹配（全是大写字母、没有数字；「键 = 值」那几条用 (?!\[REDACTED\]) 跳过已经打过码的值）。
 *
 * 宁可多打、不能漏：误打码可以接受。有意的取舍（不打码）：
 * - 16 进制串：7–12 位（短 SHA）和正好 40 位（完整 commit SHA）放过，40 位 hex 的老式 GitHub token 因此漏掉；13–39 位、41 位以上照打。
 *   紧跟在 * 后面的 40 位（mysql_native_password 的哈希）照打。
 *   只有数字没有字母的（时间戳、电话）不算 16 进制串。
 * - 含 / 且后面紧跟常见扩展名的长串当成文件路径放过，但按 / 切开的每一段都不能像 token（24 位以上、大小写字母和数字都有）。
 * - 「X is Y」只在 Y 带数字或符号时才打码（「the token is expired」「… is expired.」不动，句末的 . 和 。不算）；「X is: Y」照打。
 *   ! ? 算符号：「The password is wrong!」也会被打掉（宁可误打）。
 * - URL 里冒号后面是纯数字再接 / 的是端口（http://localhost:5173/@vite/client），不当成密码。代价：以「数字 + /」开头的 URL 密码会漏。
 * - URL 里的密码段最长认 256 个字（不然很多个 :// 时是平方级）。更长的、而且带 base64 以外字符的会漏（base64 那条兜不住）。
 *   密码段里不认裸 /（userinfo 里本来就不该有，要写成 %2F）：amqp://u:a/b@h 这种会漏。
 * - mysql 一族、sshpass、docker login 的 -p 只在同一条命令里认（到换行、引号外的 | ; & 为止；行尾用 \ 续行的接着算同一条命令）。
 *   值按 shell 的一个词算（-p'x'tail 整个打）。
 *   -p 后面的引号在这条命令里没闭合（引号配错了对），一直打到闭引号和紧连着的字、或行尾，命令后面的部分也打掉。
 * - Cookie 头里名字超过 128 字的 name=value 不打（不然很多个 Cookie: 时每个都扫到结尾）；带数字的长值还有兜底规则。
 * - Markdown 表格：任何「| 键名 |」单元格后面的值都打（a | token | grep foo 的 grep 会被误打），echo $token | grep 不算（键名前面没有 |）。
 *   表头是键名的表格（| user | password | 下面跟着分隔行）：那一列在后面连着的各行里整格打码；没有分隔行的不算表头。
 *   表头格子里按词边界含键名就算（Access Token、数据库密码），驼峰先拆开（accessToken、APIKey），复数、数字编号也算（tokens、password1），
 *   pass、pass word、PassCode、credentials 也算（| Pass | Fail | 那一列会被误打）。全大写或全小写连写的（DBPASSWORD、userpwd）
 *   含键名就算，不看词边界（tokenizer、secretary 这种全小写的会被误打；key、pass 不在这条里）。
 *   含 key / token 这个词的也算：| Key | Action |、Primary Key、Token count 那一列会被整列误打（宁可误打）。超过 128 字的格子不当表头。
 *   表里一行下面跟着分隔行时分不清是数据还是下一张表的表头，两头都做：已知密钥列照打，这行的键名列也并进来。
 *   下一张表的表头格子落在上一张表的密钥列上会被误打（宁可误打）。
 * - 单独的 key：ticket 号（BTL-12）、{…} 表达式、纯字母的键名（Enter、ArrowDown）、8 位以下的短值放过。
 * - 值中间的引号（ASCII 和全角）：后面还紧跟着字的算进值（it'ssecret99、Pa'$$w0rd），后面是空白、中英文标点、) ] } > 的当成闭引号。
 *   值前面没有开引号时，引号后面的 ) ] } > 再接着字也算进值（ab')cdef123）；有开引号的（key: 'ArrowDown')x）那是闭引号。
 *   引号值的闭引号后面紧跟着字或又一段引号的（'abc'def123、TOKEN='abc'"def"、'abc'`def`、“abc”‘def’）接着打到这个 shell 词结束。
 *   值前面的一对空引号（password: ''ab')cd1234、the password is "" "x"）跳过，后面的值照常打。
 *   「X is Y」里只有字母和撇号的（user's、don’t）是普通的话。
 * - 全角引号（“ ‘ 「 『）没闭合的打到行尾；ASCII 引号没闭合的也打到行尾，里面转义的 \" \' 不算闭引号。
 *   已知误打：引号只是撇号或引号配错了对（password: "x 后面接着一整句话）时，这一行后面的话都会被打掉，最多一整行、不跨行。
 * - 长串在 URL 的路径部分里（github.com 的 commit / blob 链接；://到长串之间没有 ? # & =，也没有空白、引号、尖括号、逗号、中文标点），
 *   只打按 / 切开后像 URL token 的那几段（16 位以上、字母数字都有、不是 40 位 hex；或者 24 位以上、大小写都有），
 *   主机名和别的段留着。代价：带数字的长 slug、UUID 那一段会被打掉（宁可误打），链接的其余部分还认得出来。
 *   工单号开头的分支名、slug（BTL-272-secret-masking、BTL-9-fix-v2：工单号后面每一小段是纯小写字母、或不超过 4 个字，
 *   里面没有 UUID）放过，只在 URL 路径里。代价：全由 4 字以内的小段拼成的长串（BTL-1-ab12-cd34-ef56-…）会漏。
 *   带 + 或 = 的是标准 base64（路径不会这样写），整串打掉。
 *   查询串里的值（?code=、&sig=）、片段里的不放过。往前只看 256 个字，更远的 :// 不算（照打）。
 *
 * 已知漏打（认不出来，没有打码）：
 * - 框线字符画的表格（│ ├─┼ 这种，psql 的 unicode 边框）、TSV（mysql -B 的制表符输出）、JSON 字符串里用字面 \n 写的表格：
 *   表头那一列下面的值认不出来（行内的「键 = 值」照打）。
 * - 有开引号的值里，引号后面跟着括号再接着字（password: 'ab')cd'）：值停在 ab，后面的 )cd 留着。
 * - 只用 \r 换行时，命令（mysql -p 之类）不按 \r 切开，只会多打。
 *
 * 耗时：主进程同步跑、输入长度不限，每条规则都不能有平方级的回溯（可选的分隔符写成 \s*(?:[:：]\s*)?，
 * 会从很多位置起跑、一直扫到行尾的部分都设上限）。不用反向引用：带 i 标志的规则遇到非 Latin1 的串，(?!\2) 每个字慢十倍，
 * 引号按种类各写一个字符类。开闭不是同一个字的全角引号停在闭引号或行尾、第一次就匹配成功（不然每个开引号都扫到行尾再失败）。
 * secrets.test.ts 里有几百 KB 对抗输入的耗时用例，每个都再跑双字节和两种全角引号的版本，新规则另有两百万字的单扫用例。
 */

export const SECRET_MASK = "[REDACTED]";

interface Hit {
  /** 整个匹配（含保留的前缀）。 */
  match: string;
  /** 要打掉的部分（去掉保留的前缀）。 */
  value: string;
  /** 匹配前面的全文、后面的全文。 */
  before: string;
  rest: string;
}

interface Rule {
  re: RegExp;
  /** 返回 true 就不打码，原样留着（比如看起来是路径）。 */
  skip?: (hit: Hit) => boolean;
  /**
   * 命令参数类（re 匹配整条命令）：在这条命令里只替换 arg 匹配到的值（arg 的第 1 个捕获组是保留的前缀）。
   * 值的引号在命令里没闭合、命令又不是到行尾结束的，往后一直打到同一种闭引号（含）或行尾。
   */
  arg?: RegExp;
  /** 看了前后文再决定换成什么（返回整个匹配的替换结果）。在 URL 路径里只打像 token 的那几段。 */
  mask?: (hit: Hit) => string;
}

/** 当成文件路径的扩展名：匹配到的长串含 /，后面紧跟这些扩展名之一（前面可以有 .test 之类的段）。 */
const PATH_EXT = /^(?:\.[\w-]+)*?\.(?:[cm]?[jt]sx?|json|md|ya?ml|toml|lock|txt|log|html?|css|scss|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|sh|sql|db|png|jpe?g|svg|gif|webp|pdf|zip|gz)\b/i;

/** 「键 = 值」里算作密钥的键名。键名后面可以紧跟一个引号（JSON / YAML 带引号的键）。 */
const KEY_NAMES =
  "password|passwd|passphrase|passcode|pwd|secret[_ -]?key|client[_ -]?secret|secret|token|api[_ -]?key|access[_ -]?key|private[_ -]?key|credentials?|authentication[_ ]string|_auth|密码|口令|密钥|令牌";
/**
 * 键名，后面可以带数字编号（password1、pwd2、token1）。编号最多 8 位：不设上限的话，键名后面跟着一长串数字时
 * 用到键名的几条规则每条都要把它扫一遍（两百万个数字约 37ms）。
 */
const DIGITS = String.raw`\d{0,8}`;
const KEY = String.raw`(?:${KEY_NAMES})${DIGITS}`;
/**
 * 值：不含空白、中英文标点，至少 4 个字符；已经打过码的跳过。
 * 首字不能是引号（引号开头的归引号规则管）；后面的引号（ASCII 和全角）只在后面还紧跟着字（不是空白、中英文标点、、 ) ] } >）时
 * 算值的一部分：it’ssecret99、it'ssecret99、Pa'$$w0rd、ab"cdef12、x9'"Lm!q 整串打；key: 'ArrowDown'、key=“ArrowDown” 的闭引号不算进值。
 */
const VALUE_HEAD = String.raw`(?!\[REDACTED\])[^\s，。；,;"'\`“”‘’「」『』]`;
const VALUE_TAIL = String.raw`(?:[^\s，。；,;"'\`“”‘’「」『』]|["'\`“”‘’「」『』](?=[^\s，。；,;、)\]}>]))`;
const VALUE = String.raw`${VALUE_HEAD}${VALUE_TAIL}{3,}`;
/**
 * 前面没有开引号的值：中间的引号后面跟着 ) ] } > 再接着字的也算进值（password: ab')cdef123）。前面有开引号的（key: 'ArrowDown')x）
 * 那个引号是闭引号，还按 VALUE 算。往回看来分：值前面紧挨着一个引号就走 VALUE；紧挨着的是一对空引号的后一个
 * （password: ''ab')cd1234，EMPTY_Q 跳过的那对）不算开引号，照样走这条。
 */
const VALUE_TAIL_BARE = String.raw`(?:[^\s，。；,;"'\`“”‘’「」『』]|["'\`“”‘’「」『』](?=[)\]}>]*[^\s，。；,;、)\]}>]))`;
const VAL = String.raw`(?:(?<!(?:^|[^"'\`“”‘’「」『』])["'\`“”‘’「」『』])${VALUE_HEAD}${VALUE_TAIL_BARE}{3,}|${VALUE})`;
/** 开引号（规则里是第 2 个捕获组）：" ' ` 和全角的 “ ‘ 「 『。 */
const OPEN = String.raw`(["'\`“‘「『])`;
/**
 * 引号里的值：从开引号到对应的闭引号（“ 配 ”、‘ 配 ’、「 配 」、『 配 』），整段打掉（多个词、很短的也打），闭引号留着。
 * 每种引号单独写一个字符类，不用 (?!\2) 反向引用。双引号、单引号里认 \" \' 这种转义。
 * 全角的几种开闭引号不是同一个字：值停在闭引号或行尾，第一次就匹配成功（要是非得看到闭引号，每个开引号都会扫到行尾再失败，
 * 很多个开引号时是平方级），所以没闭合的全角引号也在这里打到行尾。
 */
const QUOTED = String.raw`(?:(?<=")(?!\[REDACTED\]")(?:[^"\\\n]|\\.)+(?=")|(?<=')(?!\[REDACTED\]')(?:[^'\\\n]|\\.)+(?=')|(?<=\`)(?!\[REDACTED\]\`)[^\`\n]+(?=\`)|(?<=“)(?!\[REDACTED\](?:[”\r\n]|$))[^”\r\n]+(?=[”\r\n]|$)|(?<=‘)(?!\[REDACTED\](?:[’\r\n]|$))[^’\r\n]+(?=[’\r\n]|$)|(?<=「)(?!\[REDACTED\](?:[」\r\n]|$))[^」\r\n]+(?=[」\r\n]|$)|(?<=『)(?!\[REDACTED\](?:[』\r\n]|$))[^』\r\n]+(?=[』\r\n]|$))`;
/**
 * 没闭合的 ASCII 引号里的值：开引号后面到行尾都没有对应的闭引号，整段打到行尾（全角的 QUOTED 已经打到行尾了）。
 * 双引号、单引号里转义的 \" \' 照样跳过，行尾单独一个 \ 也算进去。
 */
const UNCLOSED = String.raw`(?!\[REDACTED\])(?:(?<=")(?:[^"\\\r\n]|\\[^\r\n])+\\?|(?<=')(?:[^'\\\r\n]|\\[^\r\n])+\\?|(?<=\`)[^\`\r\n]+)(?=[\r\n]|$)`;
/** 键名两边可选的引号：" ' ` 全角引号、「」『』，和 Markdown 的粗体 ** / __、斜体 * / _。 */
const KQ = String.raw`(?:["'\`“”‘’「」『』]|\*\*?|__?)?`;
/** 值前面可选的引号（不含 * _：值本身可能以它们开头，不能让它们留在外面）。 */
const VQ = String.raw`["'\`“”‘’「」『』]?`;
/** 值前面的一对空引号（password: “” hunter2xyz、密码：『』abc123def）：跳过它，后面的值照打。 */
const EMPTY_Q = String.raw`(?:(?:""|''|\`\`|“”|‘’|「」|『』)\s*)?`;
/** 冒号后面的粗体 / 斜体收尾（**password:** x、*password:* x）：后面要跟着空白，免得把值开头的 * _ 当成收尾。 */
const EMPH_END = String.raw`(?:(?:\*\*?|__?)(?=\s))?`;
/** 键和值之间：冒号、等号、「是」「为」；冒号后面可以跟着粗体的收尾。 */
const SEP = String.raw`${KQ}\s*(?:[:=：]|是|为)${EMPH_END}\s*`;
/** 环境变量式的键、单独的 key 后面：只认冒号、等号（不认「是」「为」）。 */
const ENV_SEP = String.raw`${KQ}\s*[:=：]${EMPH_END}\s*`;
/** 环境变量式的键：大写、以 _KEY / _TOKEN / _SECRET / _PASSWORD 之类结尾（区分大小写，免得 primary_key: id 被当成密钥）。 */
const ENV_TAIL = String.raw`_(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD|AUTH)(?:_?\d{1,8})?`;
const ENV_KEY = String.raw`\b[A-Z][A-Z0-9_]*${ENV_TAIL}`;
/**
 * Markdown 表格里的「| 键 | 值」：键名两边都要有 |，所以 echo $token | grep 不算；但不管是不是第一列，
 * 任何 | 键 | 单元格后面的值都打（a | token | grep foo 里的 grep 会被打掉，误打可以接受）。
 * 从 | 起跑、整段当成保留的前缀（不用往回看的断言：每个空白都要往回看一遍，慢）。
 * 表格里大小写不分（| db_password | … | 也打，宁可误打）。表头是键名、值在下面几行的表格另由 maskTables 处理。
 */
const TABLE_KEY = String.raw`\|[ \t]*${KQ}(?:${KEY}|[A-Z][A-Z0-9_]*${ENV_TAIL}|key${DIGITS})${KQ}[ \t]*\|[ \t]*`;

/** 按 / 切开的一段像不像 token：24 位以上，大小写字母和数字都有。 */
const tokenish = (seg: string): boolean => seg.length >= 24 && /[a-z]/.test(seg) && /[A-Z]/.test(seg) && /\d/.test(seg);

/** 空白：\s 的全集（含全角空格、NBSP、\v、\f、U+2028）。 */
const isSpace = (c: number): boolean =>
  c <= 32 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
/** 查询串、片段的开头和分隔：? # & =，后面的值可能就是签名。 */
const isQueryCut = (c: number): boolean => c === 63 || c === 35 || c === 38 || c === 61;
/** 和空白一样把 URL 隔开的字符：引号、尖括号、反引号、英文逗号，和中文标点（，。、；：！？）。 */
const isUrlEnd = (c: number): boolean =>
  c === 34 || c === 39 || c === 96 || c === 60 || c === 62 || c === 44 || c === 0xff0c || c === 0x3002 || c === 0x3001 || c === 0xff1b || c === 0xff1a || c === 0xff01 || c === 0xff1f;

/**
 * 匹配是不是在一个 URL 的路径部分里：从匹配往前一个字一个字地走（charCodeAt，不用回溯正则、不切子串），最多走 256 个字。
 * 先碰到 ? # & = 的不算（在查询串、片段里）；先碰到空白或 isUrlEnd 的，看它后面到匹配之间有没有 ://。
 * 256 个字里什么都没碰到、前面又还有更多的，不算（照打）。
 */
const inUrlPath = (before: string): boolean => {
  const lim = Math.max(0, before.length - 256);
  for (let i = before.length - 1; i >= lim; i--) {
    const c = before.charCodeAt(i);
    if (isQueryCut(c)) return false;
    if (isSpace(c) || isUrlEnd(c)) return before.slice(i + 1).includes("://");
  }
  return lim === 0 && before.includes("://");
};

/** URL 路径里的一段像不像 token：16 位以上、字母数字都有、不是 40 位 hex（commit SHA）；或者 24 位以上、大小写都有（Slack webhook 的秘密段）。 */
const urlTokenish = (seg: string): boolean =>
  (seg.length >= 16 && /[A-Za-z]/.test(seg) && /\d/.test(seg) && !/^[0-9a-f]{40}$/i.test(seg)) ||
  (seg.length >= 24 && /[a-z]/.test(seg) && /[A-Z]/.test(seg));

/**
 * URL 路径里工单号开头的分支名、slug（BTL-272-secret-masking、BTL-9-fix-v2）：工单号后面的每一小段只能是纯小写字母，
 * 或者不超过 4 个字（v2、h264）；剩下的部分里有 UUID 的照打（BTL-9-550e8400-e29b-…）。
 */
const ticketSlug = (seg: string): boolean => {
  const m = /^[A-Z]+-\d+((?:-[a-z0-9]+)*)$/.exec(seg);
  if (!m) return false;
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(m[1])) return false;
  return m[1]
    .split("-")
    .slice(1)
    .every((part) => /^[a-z]+$/.test(part) || part.length <= 4);
};

/** 单独的 key 的值像不像普通的东西：ticket 号、{…} 表达式、纯字母的键名（Enter、ArrowDown）、8 位以下的短值。 */
const plainKeyValue = (v: string): boolean => /^[A-Z]+-\d+$/.test(v) || /^[{([]/.test(v) || /^[A-Za-z]+$/.test(v) || v.length < 8;

/**
 * 一条命令（到换行、| ; & 为止；引号里的、\ 转义的 | ; & 和行尾 \ 续行的换行不算，跳过整对引号，没闭合的引号到行尾）：整段一次匹配下来，再在段里只替换某个参数后面的值。
 * 不设长度上限：段一直到命令结束，同一行里后面的命令名在下一段里照样认。整段被吃掉，下一次从段尾接着找，
 * 所以不会从段里每个位置都重新往后扫；后面没有别的东西，外层的 * 不会回溯。
 */
const command = (names: string): RegExp =>
  new RegExp(String.raw`\b(?:${names})\b(?:[^\n|;&"'\\]+|\\(?:\r?\n|[^\n])|"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)*`, "g");
/**
 * -p 后面的值：shell 的一个词，到引号外的空白为止。带引号的到闭引号（认 \" \' 这种转义；没闭合就到段尾），
 * 引号前后紧接着的字也算（-p'x'tail、-pa"b c"d：bash 会接成同一个词），引号外 \ 转义的空白也算（-pMy\ Secret）。
 */
const P_VALUE = String.raw`(?!\[REDACTED\])(?:\\(?:\r?\n|[^\n])|"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|[^\s"'\\])+`;

/** 值里最后一个引号在这条命令里没闭合：返回那种引号（按 P_VALUE 的读法，一个字一个字地走）。 */
const openQuoteAtEnd = (v: string): string | null => {
  let q: string | null = null;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (q === null) {
      if (c === "\\") i++;
      else if (c === '"' || c === "'") q = c;
    } else if (c === "\\") i++;
    else if (c === q) q = null;
  }
  return q;
};

/**
 * 从没闭合的引号 open 里接着往后走，到这个 shell 词的末尾：先走到闭引号（跳过 \ 转义的；遇到行尾就停），
 * 再接着走引号外紧连的字（又碰到引号就再走到它的闭引号），到空白、| ; & 或行尾为止。返回走到的下标。
 */
const wordEnd = (s: string, from: number, open: string): number => {
  let q: string | null = open;
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === "\n" || c === "\r") break;
    if (q !== null) {
      i++;
      if (c === "\\" && i < s.length && s[i] !== "\n" && s[i] !== "\r") i++;
      else if (c === q) q = null;
    } else if (isSpace(c.charCodeAt(0)) || c === ";" || c === "|" || c === "&") break;
    else {
      i++;
      if (c === "\\" && i < s.length && s[i] !== "\n" && s[i] !== "\r") i++;
      else if (c === '"' || c === "'") q = c;
    }
  }
  return i;
};

/**
 * 命令参数类规则：每条命令（cmd）里只换 arg 后面的值。值的引号没闭合、命令却停在 | ; & 上（引号配错了对，比如前面
 * 有个 mysql's），往后一直打到同一种闭引号和紧连着的字、或行尾，从那里接着找下一条命令（往后打过的那段里出现的命令名
 * 不再当成新命令）。一遍扫过去，线性。
 */
const maskCommands = (s: string, cmd: RegExp, arg: RegExp): string => {
  let out = "";
  let last = 0;
  cmd.lastIndex = 0;
  for (let m = cmd.exec(s); m; m = cmd.exec(s)) {
    if (m[0].length === 0) {
      cmd.lastIndex++;
      continue;
    }
    const end = m.index + m[0].length;
    let open: string | null = null;
    arg.lastIndex = 0;
    // 值的引号没闭合时，P_VALUE 一直吃到段尾（引号里什么都吃，段里又没有换行），所以没闭合的值总在段尾，不用另外核对位置。
    const seg = m[0].replace(arg, (v: string, keep: string) => {
      open = openQuoteAtEnd(v.slice(keep.length));
      return `${keep}${SECRET_MASK}`;
    });
    // 往后走到这个词的末尾（闭引号和紧连着的字）；走过的都吃掉，下一条命令从那里接着找，总共是线性的。
    const next = open === null ? end : wordEnd(s, end, open);
    out += s.slice(last, m.index) + seg;
    last = next;
    cmd.lastIndex = next;
  }
  return out + s.slice(last);
};

/**
 * 表头的单元格里有没有密钥类的键名（和 TABLE_KEY 认的一样），不必是整格：Access Token、DB Password、password (prod)、数据库密码都算
 * （Primary Key、Token count 也会算，误打可以接受）。比 TABLE_KEY 多认 pass（pass word、Pass_word、PassCode 拆开后都落在它上面），
 * 后面可以跟复数 s 和数字编号（tokens、password1、Token2）。超过 128 字的格子不当表头（限长：不然长格子里每个位置都要试一遍）。
 */
const HEADER_KEY = new RegExp(String.raw`(?:^|[^A-Za-z0-9])(?:${KEY_NAMES}|pass|[A-Z][A-Z0-9_]*${ENV_TAIL}|key)s?${DIGITS}(?![A-Za-z0-9])`, "i");
/**
 * 全大写或全小写连写的格子（DBPASSWORD、dbpassword、SECRETKEY）没有驼峰可拆、也没有词边界：只要里面含这些键名就算。
 * key、pass 太常见（monkey、Keystone、passenger），不在里面。大小写混着的（Tokenizer）按驼峰拆开后的词边界算，不走这条。
 */
const HEADER_RUN = /password|passwd|passphrase|passcode|pwd|secret|token|credential|apikey|api_key|accesskey|privatekey/i;
/** 表头格子先把驼峰拆开（accessToken → access Token、APIKey → API Key），再按词边界找键名（复数 tokens、passwords 也算）。 */
const splitCamel = (t: string): string => t.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
/**
 * 表格的分隔行：Markdown 的 |---|:-:|（引用块里的 > |---| 也算），mysql 输出的 +----+----+，tabulate / pandoc grid 表头下面的 +====+。
 * 要有 | 或 + 和至少一个 - 或 =，此外只能是空白、冒号和 >。
 */
const TABLE_RULE = /^(?=[^|+]*[|+])(?=[^=-]*[=-])[\s|+:>=-]+$/;

/** 按没转义的 | 切开一行（第一段是第一个 | 前面的字，表格行一般是空的）。 */
const cells = (line: string): string[] => {
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "|") {
      out.push(line.slice(from, i));
      from = i + 1;
    }
  }
  out.push(line.slice(from));
  return out;
};

/** 一格整格打码，两边的空白留着。空的、已经打过码的不动。 */
const maskCell = (cell: string): string => {
  let a = 0;
  let b = cell.length;
  while (a < b && isSpace(cell.charCodeAt(a))) a++;
  while (b > a && isSpace(cell.charCodeAt(b - 1))) b--;
  if (a === b || cell.slice(a, b) === SECRET_MASK) return cell;
  return cell.slice(0, a) + SECRET_MASK + cell.slice(b);
};

/** 一行里是密钥类键名的那几格的下标（从小到大）。 */
const headerCols = (line: string): number[] => {
  const out: number[] = [];
  cells(line).forEach((c, k) => {
    const t = c.trim();
    // 空格子直接跳过（很多个 | 的行每格都跑两三条正则，200KB 约 30ms）。
    if (t.length === 0 || t.length > 128) return;
    // 拆开前后都试：拆开会把 PassWord、PassPhrase、PASSWord 这种整词切断（Pass Word），原样的也要认。
    if (HEADER_KEY.test(t)) out.push(k);
    else if (t === t.toLowerCase() || t === t.toUpperCase()) {
      if (HEADER_RUN.test(t)) out.push(k);
    } else {
      const u = splitCamel(t);
      if (u !== t && HEADER_KEY.test(u)) out.push(k);
    }
  });
  return out;
};

/**
 * 把一行里 cols 那几列整格打码。按这行的格子走（不按 cols 走）：cols 可能比这行宽得多（很宽的表头下面很多短行），
 * 每行的花销不超过这行的长度。
 */
const maskRow = (line: string, cols: Set<number>): string => {
  const row = cells(line);
  for (let k = 0; k < row.length; k++) if (cols.has(k)) row[k] = maskCell(row[k]);
  return row.join("|");
};

/**
 * 表头是键名、值在下面几行的表格（| user | password |、mysql 的查询结果）：一张表里第一个下一行是分隔行的行是表头，
 * 表头里是密钥类键名的那几列，后面连着的表格行（含 | 的行，分隔行跳过）整格打码，遇到既不含 | 也不是分隔行的行（空行、正文）结束。
 * 表里又有一行下面跟着分隔行：可能是紧挨着的下一张表的表头（mysql -t -e "q1; q2"、Markdown 两张表之间没空行），
 * 也可能只是数据（mysql 最后一行数据下面的 +---+、org 表格的 |---+---|），还可能前面「表头」认错了（表格上面紧挨着一行
 * 带 | 的命令：mysql -e "…" | cat）。分不清，所以两头都做：已知的密钥列照常整格打（这行是数据时，secret_2024! 这种
 * 含键名的值不能放过；是表头时，键名格子被误打可以接受），再把这行里的键名列并进来（宁可多打）。
 * 没有表头的「| password | x |」由 TABLE_KEY 那条规则管。按行扫一遍，线性。换行认 \n、\r\n 和单独的 \r。
 */
const maskTables = (s: string): string => {
  if (!s.includes("|")) return s;
  // 切开后偶数下标是行，奇数下标是换行符（原样拼回去）。
  const parts = s.split(/(\r\n|\r|\n)/);
  const lineAt = (i: number): string | undefined => (i >= 0 && i * 2 < parts.length ? parts[i * 2] : undefined);
  const isRule = (line: string | undefined): boolean => line !== undefined && TABLE_RULE.test(line);
  /** 这张表的密钥列；inTable：已经读过表头。 */
  let cols = new Set<number>();
  let inTable = false;
  const n = (parts.length + 1) / 2;
  for (let i = 0; i < n; i++) {
    const line = parts[i * 2];
    if (TABLE_RULE.test(line)) continue;
    if (!line.includes("|")) {
      cols = new Set();
      inTable = false;
      continue;
    }
    const next = lineAt(i + 1);
    const ruleBelow = isRule(next);
    if (!inTable) {
      if (ruleBelow) {
        inTable = true;
        cols = new Set(headerCols(line));
      }
      continue;
    }
    if (cols.size > 0) parts[i * 2] = maskRow(line, cols);
    // 只往集合里加这行的键名列（不重建、不排序）：很宽的表头下面每行都并一次时，重建是平方级（200KB 约 8s）。
    if (ruleBelow) for (const k of headerCols(line)) cols.add(k);
  }
  return parts.join("");
};

const RULES: Rule[] = [
  // 私钥 / 证书块：BEGIN 到 END 整段（没有 END 就到结尾）。
  { re: /-----BEGIN[^-]{0,60}-----[\s\S]*?(?:-----END[^-]{0,60}-----|$)/g },
  // 剩下的 BEGIN 行头。
  { re: /-----BEGIN[^-]{0,60}-----/g },
  // 键后面的值在引号里（"、'、`）：到同一个闭引号整段打掉（"my secret phrase"、'ab'）。要在别的规则之前：不然值里先被换进占位符，剩下的字就漏了。
  { re: new RegExp(`(${KEY}${SEP}${EMPTY_Q}${OPEN})${QUOTED}`, "gi") },
  { re: new RegExp(`(${ENV_KEY}${ENV_SEP}${EMPTY_Q}${OPEN})${QUOTED}`, "g") },
  { re: new RegExp(`(\\bkey${DIGITS}${ENV_SEP}${EMPTY_Q}${OPEN})${QUOTED}`, "gi"), skip: (h) => plainKeyValue(h.value) },
  { re: new RegExp(`(\\b${KEY}${KQ}\\s+is\\s*(?:[:：]\\s*)?${EMPTY_Q}${OPEN})${QUOTED}`, "gi") },
  { re: new RegExp(`(${TABLE_KEY}${EMPTY_Q}${OPEN})${QUOTED}`, "gi") },
  // 引号没闭合、值里有空格（password: "two words、password = 'hunter 2）：照 mysql 的做法打到行尾。闭合了的上面已经打过，
  // 占位符跳过。同一种引号之间不会重叠着扫，总共是线性的。
  { re: new RegExp(`(${KEY}${SEP}${EMPTY_Q}${OPEN})${UNCLOSED}`, "gi") },
  { re: new RegExp(`(${ENV_KEY}${ENV_SEP}${EMPTY_Q}${OPEN})${UNCLOSED}`, "g") },
  // 闭引号后面紧跟着字（password: 'abc'def123、TOKEN='abc'"def"：shell 里是同一个词）：接着打到这个词结束，闭引号留着。
  // 只接在上面打过码的引号值后面；后面又是一段引号的整段算进去（没闭合的到行尾）。每个字只有一种走法，线性。
  { re: /(\[REDACTED\]["'`”’」』])(?:[^\s，。；,;、)\]}>|"'`“”‘’「」『』]|"[^"\r\n]*"?|'[^'\r\n]*'?|`[^`\r\n]*`?|“[^”\r\n]*”?|‘[^’\r\n]*’?|「[^」\r\n]*」?|『[^』\r\n]*』?)+/g },
  // URL 里的账号密码：scheme://user:pass@host，只换密码段。用户名可以是空的（redis://:pw@host）；密码里不认裸 /（要写成 %2F）。
  // 冒号后面是纯数字再接 / 的是端口（localhost:5173/@vite/client）。长度设上限：很多个 :// 时不会每个都扫到结尾。
  // 密码段用「先行断言 + 反向引用」一次取到最长、不回溯（密码里没有 @，后面不是 @ 就肯定不是）。
  { re: /(:\/\/[^\s:@/]{0,256}:)(?!\[REDACTED\])(?!\d+\/)(?=([^\s@/]{1,256}))\2(?=@[^\s@/])/g },
  // URL 查询串里的签名、授权码、token（?code=…、Azure 的 &sig=…、S3 的 X-Amz-Signature=…）：整个值打掉。
  {
    re: /([?&;](?:sig|signature|code|access_token|refresh_token|id_token|auth|apikey|api_key|key|client_secret|x-amz-signature|x-amz-security-token|x-amz-credential|x-goog-signature|x-goog-credential)=)(?!\[REDACTED\])[^\s&#"'<>`)]+/gi,
  },
  // Slack / Discord webhook：路径里的秘密段可能没有数字，整段路径打掉。
  { re: /(\bhooks\.slack\.com\/(?:services|workflows|triggers)\/)[A-Za-z0-9/_-]{1,512}/g },
  { re: /(\bdiscord(?:app)?\.com\/api\/webhooks\/)[A-Za-z0-9/_-]{1,512}/g },
  // Authorization: Bearer xxx / Basic xxx
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  // Basic：前面是 Authorization:，或者值里有数字、=、+、/（「Basic Settings」「Basic Authentication」不算）。
  { re: /(?<=\bAuthorization["']?\s{0,16}[:=]\s{0,16}["']?)Basic\s+[A-Za-z0-9+/=]{8,}/gi },
  { re: /\bBasic\s+(?=[A-Za-z]*[0-9+/=])[A-Za-z0-9+/=]{8,}/gi },
  // Cookie 头：打掉 name=value; name=value 这一串，后面的话留着。名字限 128 字：不然很多个 Cookie: 时每个都扫到结尾。
  { re: /(\b(?:Set-)?Cookie\s*:\s*)(?!\[REDACTED\])[^\s=;]{1,128}=[^\s;]*(?:;\s*[^\s=;]{1,128}=[^\s;]*)*/gi },
  // 后面没有 name=：退回到打掉带数字的长串（Cookie: abc123secretvalue）。先行断言限 128 字。
  { re: /(\b(?:Set-)?Cookie\s*:\s*)(?!\[REDACTED\])(?=[^\s;]{0,128}\d)(?=[^\s;]{0,128}[A-Za-z])[^\s;]{8,}/gi },
  // 命令行：curl -u user:pass / --user user:pass 只换密码；--password xxx、--token xxx（空格或 = 分隔）；docker login -p xxx；
  // mysql -pxxx / -p'two words'（只认 mysql、mysqldump、mariadb、mysqladmin 后面的 -p：mkdir -pv、gcc -pthread 不算）；
  // sshpass -p xxx（-p 和值之间可以有空格）。引号没闭合的到行尾。
  { re: /((?:^|\s)(?:-u|--user)(?:\s+|=)?["']?[^\s:"']*:)(?!\[REDACTED\])[^\s"']+/g },
  { re: /((?:^|\s)--?(?:password|passwd|pass|passphrase|token|api-key|apikey|secret|auth-token)(?:\s+|=)["']?)(?!\[REDACTED\])[^\s"']+/gi },
  { re: command(String.raw`docker\s+login`), arg: new RegExp(String.raw`(\s-p\s+)${P_VALUE}`, "g") },
  { re: command("mysql|mysqldump|mariadb|mysqladmin"), arg: new RegExp(String.raw`(\s-p)${P_VALUE}`, "g") },
  { re: command("sshpass"), arg: new RegExp(String.raw`(\s-p\s*)${P_VALUE}`, "g") },
  // JWT
  { re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
  // GitHub
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  // GitLab、npm、Stripe（webhook 签名密钥、secret / restricted key）
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { re: /\bnpm_[A-Za-z0-9]{20,}/g },
  { re: /\bwhsec_[A-Za-z0-9+/=]{16,}/g },
  { re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  // Anthropic / OpenAI 之类：sk-ant-…、sk-…
  { re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  // AWS access key
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // Slack
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  // 「密码是 xxx」「token=xxx」「SECRET_KEY=xxx」「_auth=xxx」：只换值。
  // 引号没闭合（被截断的 "hunter2xyz）也照打：前缀后面可以跟一个引号。
  { re: new RegExp(`(${KEY}${SEP}${EMPTY_Q}${VQ})${VAL}`, "gi") },
  // 环境变量式的键（区分大小写，免得 primary_key: id 被当成密钥）。
  { re: new RegExp(`(${ENV_KEY}${ENV_SEP}${EMPTY_Q}${VQ})${VAL}`, "g") },
  // 单独的 key（key=…、"key": …、表格里的 | key | …）：前面不能连着字母、数字、_（primary_key、monkey 不算）。
  { re: new RegExp(`(\\bkey${DIGITS}${ENV_SEP}${EMPTY_Q}${VQ})${VAL}`, "gi"), skip: (h) => plainKeyValue(h.value) },
  // Markdown 表格：| password | hunter2xyz |。
  { re: new RegExp(`(${TABLE_KEY}${EMPTY_Q}${VQ})${VAL}`, "gi") },
  // 「token abc…」「secret abc…」：键后面隔一个空格跟着一长串（16 位以上，有字母也有数字）。
  { re: /(\b(?:token|secret|password|passwd|api[_ -]?key)\s+)(?!\[REDACTED\])(?=[A-Za-z0-9._~+/=-]*\d)(?=[A-Za-z0-9._~+/=-]*[A-Za-z])[A-Za-z0-9._~+/=-]{16,}/gi },
  // 「the password is: x」：带冒号的照打。
  { re: new RegExp(`(\\b${KEY}${KQ}\\s+is\\s*[:：]\\s*${EMPTY_Q}${VQ})${VALUE_HEAD}${VALUE_TAIL}*`, "gi") },
  // 「the password is hunter2xyz」「token is "abc123def」（引号没闭合）：值里要有数字或符号，免得「the token is expired」
  // 「… is expired.」「the token is user's」这种话被打码（句末的 . 不算；! ? 算，宁可误打）。
  {
    re: new RegExp(`(\\b${KEY}${KQ}\\s+is\\s+${EMPTY_Q}${VQ})${VALUE}`, "gi"),
    // 只有字母（可以带一个撇号：don't、user’s）再加句号的是普通的话。
    skip: (h) => /^[A-Za-z]+(?:['’][A-Za-z]+)*\.*$/.test(h.value),
  },
  // 16 进制串（至少有一个字母、一个数字）：13–39 位、41 位以上都打（32 位的 Datadog / Twilio key、SHA-256）；7–12 位和 40 位的当成 commit SHA 放过。
  // 紧跟在 * 后面的 40 位是 mysql_native_password 的哈希（mysql.user 的 authentication_string），照打。
  { re: /\b(?=[0-9a-fA-F]*[a-fA-F])(?=[0-9a-fA-F]*\d)(?:(?<=\*)|(?![0-9a-fA-F]{40}\b))[0-9a-fA-F]{13,}\b/g },
  // 长的 base64 / base64url 串：32 位以上、大小写字母和数字都有（单词不会这样）。含 / 而且后面紧跟扩展名（文件路径，
  // 每段都不像 token）、或者在 URL 的路径部分里（github.com/o/Repo/commit/<sha>，每段都不像 URL token）的，放过。
  {
    re: /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{32,}={0,2}/g,
    mask: (h) => {
      if (!h.match.includes("/")) return SECRET_MASK;
      const segs = h.match.split("/");
      if (PATH_EXT.test(h.rest) && !segs.some(tokenish)) return h.match;
      // URL 路径：只打像 token 的那几段，主机名、别的段和工单号 slug 留着，链接还认得出来。
      // 带 + 或 = 的是标准 base64（路径不会这样写）：整串打掉，按 / 切开后短的几段会漏。
      if (inUrlPath(h.before)) {
        if (/[+=]/.test(h.match)) return SECRET_MASK;
        return segs.map((seg) => (urlTokenish(seg) && !ticketSlug(seg) ? SECRET_MASK : seg)).join("/");
      }
      return SECRET_MASK;
    },
  },
];

/** 把能认出来的密钥换成 SECRET_MASK。 */
export function maskSecrets(s: string): string {
  // 表头表格整格打码：排在前面，整格先换成一个占位符，后面的规则不会把格子拆开。
  let out = maskTables(s);
  for (const { re, skip, arg, mask } of RULES) {
    if (arg) {
      out = maskCommands(out, re, arg);
      continue;
    }
    out = out.replace(re, (...args: unknown[]) => {
      const m = args[0] as string;
      // replace 回调的参数：match, 各捕获组…, offset, whole[, groups]。有捕获组时第二个参数是要保留的前缀。
      const keep = typeof args[1] === "string" ? args[1] : "";
      if (skip || mask) {
        const offset = args[args.length - 2] as number;
        const whole = args[args.length - 1] as string;
        if (typeof offset === "number" && typeof whole === "string") {
          const hit = { match: m, value: m.slice(keep.length), before: whole.slice(0, offset), rest: whole.slice(offset + m.length) };
          if (mask) return mask(hit);
          if (skip?.(hit)) return m;
        }
      }
      return `${keep}${SECRET_MASK}`;
    });
  }
  return out;
}

/** 有没有能认出来的密钥（打码前后不一样）。 */
export function hasSecret(s: string): boolean {
  return maskSecrets(s) !== s;
}
