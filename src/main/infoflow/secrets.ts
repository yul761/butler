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
 *   gh secret set 的 --body / -b、openssl 的 -k / -pass(in|out) pass:、ssh-keygen 的 -N / -P、aws configure set 里键名含
 *   secret / token / password / key 的值、htpasswd -b 的最后一个位置参数也一样（openssl 的 -pass env:X、file:x 也会被打掉）。
 *   --password-stdin 前面 echo x | 的 x（往前看 128 字以内）、后面 <<< x 的 x 也打（$VAR 不打）。
 *   命令行的 --password / --token / -u user: 后面是带空格的引号值的，整段打到闭引号（没闭合的到行尾）。
 * - 值前面用 \ 续行（password=\⏎x、--token=\⏎x、curl -u bob:\⏎x、-u \⏎bob:x）：跳过续行，打下一行的值；续行后面什么都没有的不打。
 *   「X is \⏎ Y」这种句子里的续行不认。
 * - Authorization: 后面不管是什么 scheme（Bearer、Basic、token、Bot、Negotiate…）、或者没写 scheme，8 个字以上的值都打
 *   （Authorization: required 这种话也会被打掉，宁可误打）。
 * - 单独的 pass、pin（还有 pinCode、pin_number）当键名（前面连着字母数字的 bypass、spin 不算；pass: true 也会被打）。
 *   键名后面可以直接接一段驼峰后缀（passwordHash、tokenValue；tokenizer、secretary、passwordless 也会被当成键名）。
 * - Kubernetes env 的「name: 含键名的名字」下一行「value: x」：value 后面整行打掉（valueFrom 不算）。
 * - YAML 块标量（password: |、token: >-）：下面缩进不比第一个非空行浅的那几行（含开头和中间的空行）整块打成一个占位符，
 *   占位符的缩进取第一个非空行的。
 *   值按 shell 的一个词算（-p'x'tail 整个打）。
 *   -p 后面的引号在这条命令里没闭合（引号配错了对），一直打到闭引号和紧连着的字、或行尾，命令后面的部分也打掉。
 * - Cookie 头里名字超过 128 字的 name=value 不打（不然很多个 Cookie: 时每个都扫到结尾）；带数字的长值还有兜底规则。
 * - Markdown 表格：任何「| 键名 |」单元格后面的值都打（a | token | grep foo 的 grep 会被误打），echo $token | grep 不算（键名前面没有 |）。
 *   表头是键名的表格（| user | password | 下面跟着分隔行）：那一列在后面连着的各行里整格打码；没有分隔行的不算表头。
 *   表头格子里按词边界含键名就算（Access Token、数据库密码），驼峰先拆开（accessToken、APIKey），复数、数字编号也算（tokens、password1），
 *   pass、pass word、PassCode、credentials 也算（| Pass | Fail | 那一列会被误打）。连写的（DBPASSWORD、userpwd、Authtoken）
 *   含键名就算，不看词边界、不看大小写（tokenizer、Tokenizer、secretary 会被误打；key、pass 不在这条里）。
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
 * - 键名带复数、数字编号、一小段后缀的也算（passwords、password_123、DB_PASSWORD_PROD、API_TOKEN_2_STAGING、MY_KEY_PROD）；
 *   后缀最长 16 个字，更长的不算键名。前面紧挨着字母数字的不算（xtoken is …）。
 * - 含全角 ASCII（ｐａｓｓｗｏｒｄ＝、｜）、Default_Ignorable 的字（零宽字符、软连字符 U+00AD、U+2061–2064、方向控制符、变体选择符、
 *   标签字符…）、NFKC 换得成单个 ASCII 字母或数字的兼容字符（𝐩𝐚𝐬𝐬𝐰𝐨𝐫𝐝 这种数学字母、ⓟ、上标字母、上下标数字 ₁ ²、数学数字 𝟏；
 *   带圈、带框的只换字母，①、⑴、⒈、🄁 不换；™、ﬁ、℃ 也不换）或框线字符（│ ├─┼，psql 的 unicode 边框）的行
 *   先换成半角、去掉不可见的字、兼容字符换成 ASCII、框线换成 | - +，再跑上面的规则。中文常用的全角标点（！（），：；？）不换。
 *   全角冒号「：」不换成半角（它在 URL 后面是 URL 的边界），要它当冒号的规则自己认：URL 里的账号密码（admin：S3cretPw＠db）、
 *   curl -u（admin：hunter2）、Authorization：、Cookie：、「键：值」。
 *   打到了码就返回换过的那一份（这几行的全角字、框线跟着变成半角）；什么都没打到就原样返回。
 *
 * 已知漏打（认不出来，没有打码）：
 * - TSV（mysql -B 的制表符输出）、JSON 字符串里用字面 \n 写的表格：表头那一列下面的值认不出来（行内的「键 = 值」照打）。
 * - YAML 块标量的键名是单独的 pass / pin、或者 k8s 的 value 也写成块标量（value: |）的：认不出来。
 * - Default_Ignorable 的字去掉以后，原来被它隔开的两个词会连在一起（「token\u00ADis」变成 tokenis），\b 认不出后一个词的词头：
 *   软连字符、变体选择符夹在词中间又正好隔开键名的，可能漏（接受）。
 * - 有开引号的值里，引号后面跟着括号再接着字（password: 'ab')cd'）：值停在 ab，后面的 )cd 留着。
 * - 只用 \r 换行时，命令（mysql -p 之类）不按 \r 切开，只会多打。
 *
 * 耗时：主进程同步跑、输入长度不限，每条规则都不能有平方级的回溯（可选的分隔符写成 \s*(?:[:：]\s*)?，
 * 会从很多位置起跑、一直扫到行尾的部分都设上限）。不用反向引用：带 i 标志的规则遇到非 Latin1 的串，(?!\2) 每个字慢十倍，
 * 引号按种类各写一个字符类。例外：YAML 块标量那条用 \2 认后面每一行的缩进——\2 只是行首的一段空白，每行只在行首比一次（不是每个字一次），
 * 比不上就停，不回溯，总共是线性的；URL 密码段、echo 那两条的 \2 是「先行断言 + 反向引用」一次取整段，也不回溯。
 * 开闭不是同一个字的全角引号停在闭引号或行尾、第一次就匹配成功（不然每个开引号都扫到行尾再失败）。
 * secrets.timing.test.ts 里有 200KB 对抗输入的耗时用例（每个 50ms 以内：先热身一次，三次取最快），每个都再跑双字节、两种全角引号、
 * 要先换半角的版本，新规则另有单个前缀接 200KB 同一种字的用例。这些用例放在单独的 vitest 项目 timing 里，等别的测试跑完再串行跑。
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

/** 命令参数类规则的函数形式：seg 是整条命令，要打的值交给 mask，返回替换后的命令。 */
type CommandArgs = (seg: string, mask: (value: string) => string) => string;

interface Rule {
  re: RegExp;
  /** 返回 true 就不打码，原样留着（比如看起来是路径）。 */
  skip?: (hit: Hit) => boolean;
  /**
   * 命令参数类（re 匹配整条命令）：在这条命令里只替换 arg 匹配到的值（arg 的第 1 个捕获组是保留的前缀）。
   * 值的引号在命令里没闭合、命令又不是到行尾结束的，往后一直打到同一种闭引号（含）或行尾。
   * 也可以是函数：拿到整条命令，自己决定打哪几个词，每个要打的词交给 mask（它记下没闭合的引号，返回占位符）。
   */
  arg?: RegExp | CommandArgs;
  /** 看了前后文再决定换成什么（返回整个匹配的替换结果）。在 URL 路径里只打像 token 的那几段。 */
  mask?: (hit: Hit) => string;
  /** 匹配从 KEY 开头（「键 = 值」「键 is 值」、YAML 块标量）：只在 KEY_AT 扫出来的候选起点上试，见 maskRules。 */
  keyed?: true;
}

/** 一处替换：旧文本里从 at 起的 len 个字换成了 to（maskRules 拿它把 KEY 规则的候选起点挪到新文本上）。 */
interface Edit {
  at: number;
  len: number;
  to: string;
}

/** 当成文件路径的扩展名：匹配到的长串含 /，后面紧跟这些扩展名之一（前面可以有 .test 之类的段）。 */
const PATH_EXT = /^(?:\.[\w-]+)*?\.(?:[cm]?[jt]sx?|json|md|ya?ml|toml|lock|txt|log|html?|css|scss|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|sh|sql|db|png|jpe?g|svg|gif|webp|pdf|zip|gz)\b/i;

/** 「键 = 值」里算作密钥的键名。键名后面可以紧跟一个引号（JSON / YAML 带引号的键）。 */
const KEY_NAMES =
  "password|passwd|passphrase|passcode|pwd|secret[_ -]?key|client[_ -]?secret|secret|token|api[_ -]?key|access[_ -]?key|account[_ -]?key|private[_ -]?key|credential|authentication[_ ]string|_auth|密码|口令|密钥|令牌";
/**
 * 键名，后面可以带数字编号（password1、pwd2、token1、password_1、token-2、password20240115093000）。编号不设上限：
 * 设上限的话 password123456789=x 整个漏掉。每个键名后面的数字只被从这个键名起跑的那一次扫到，总共是线性的
 * （两百万个数字约 37ms，200KB 约 4ms）。
 */
const DIGITS = String.raw`(?:[_-]?\d+)?`;
/**
 * 键名后面的一个单词后缀（DB_PASSWORD_PROD、SECRET_KEY_A、password_prod、token-v2、驼峰的 passwordHash、tokenValue）：
 * 一个 _ 或 -，再跟 1 到 16 个字母数字；或者不带分隔符、以字母开头的 1 到 16 个字母数字（驼峰）。限长、只认一段：
 * 从每个键名起跑最多多看 17 个字，线性（password_policy、token_count、tokenizer、secretary 这种也会被当成键名，宁可误打）。
 * 不带分隔符的要以字母开头：不然和前面的数字编号抢同一串数字（password 接二十万个 1，每条规则回溯十几倍，200KB 过 100ms）。
 * 后缀后面必须不是字母数字：KEY 后面接的（KQ、空白、: = |）都不以字母数字开头。后缀开头先看后面是不是连着 17 个以上字母数字，
 * 是的话这段后缀不可能成立，直接跳过，不进回溯（password1password1… 以前每个键名退 16 次、每次都把 SEP 再试一遍，200KB 约 12ms）。
 */
const KEY_SUFFIX = String.raw`(?:(?:[_-](?![A-Za-z0-9]{17})[A-Za-z0-9]{1,16}|(?![A-Za-z0-9]{17})[A-Za-z][A-Za-z0-9]{0,15})(?![A-Za-z0-9]))?`;
/** 键名，可以是复数（passwords、tokens、secrets），再跟编号和一个单词后缀。 */
const KEY = String.raw`(?:${KEY_NAMES})s?${DIGITS}${KEY_SUFFIX}`;
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
/** 和 VAL 一样分有没有开引号，但不限长度（「the password is: x」带冒号的，一个字也打）。 */
const VAL_ANY = String.raw`(?:(?<!(?:^|[^"'\`“”‘’「」『』])["'\`“”‘’「」『』])${VALUE_HEAD}${VALUE_TAIL_BARE}*|${VALUE_HEAD}${VALUE_TAIL}*)`;
/**
 * 「X is Y」的键名前面：不能紧挨着字母数字（不用 \b：The DB_PASSWORD is … 里 _ 和 P 之间没有 \b，环境变量式的键名也要认）。
 */
const NOT_AFTER_ALNUM = String.raw`(?<![A-Za-z0-9])`;
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
/**
 * 值前面的空引号（password: “” hunter2xyz、密码：『』abc123def、password: """" x、the password is "" "" x）：跳过，后面的值照打。
 * 可以有好几对：每对是固定的两个字、和后面的空白不重叠，没有歧义，线性。
 */
const EMPTY_Q = String.raw`(?:(?:""|''|\`\`|“”|‘’|「」|『』)\s*)*`;
/** 冒号后面的粗体 / 斜体收尾（**password:** x、*password:* x）：后面要跟着空白，免得把值开头的 * _ 当成收尾。 */
const EMPH_END = String.raw`(?:(?:\*\*?|__?)(?=\s))?`;
/** 分隔符后面用 \ 续行的（password=\⏎S3cretPw、PGPASSWORD=\⏎…）：跳过续行，值在下一行。只认一次，和前后的空白不重叠，线性。 */
const CONT = String.raw`(?:\\\r?\n\s*)?`;
/** 键和值之间：冒号、等号、「是」「为」；冒号后面可以跟着粗体的收尾、\ 续行。 */
const SEP = String.raw`${KQ}\s*(?:[:=：]|是|为)${EMPH_END}\s*${CONT}`;
/** 环境变量式的键、单独的 key 后面：只认冒号、等号（不认「是」「为」）。 */
const ENV_SEP = String.raw`${KQ}\s*[:=：]${EMPH_END}\s*${CONT}`;
/**
 * 环境变量式的键：大写、以 _KEY / _TOKEN / _SECRET / _PASSWORD 之类结尾（区分大小写，免得 primary_key: id 被当成密钥）。
 * 可以是复数（MY_KEYS），带编号，再跟一段大写后缀（MY_KEY_PROD：_KEY 不在不分大小写的键名里，只能在这里认）。
 */
const ENV_TAIL = String.raw`_(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD|AUTH|DSN)S?(?:_?\d+)?(?:_[A-Z0-9]{1,16})?`;
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
  new RegExp(String.raw`\b(?:${names})\b(?:[^\n|;&"'\\]+|\\(?:\r?\n|[^\n])|"(?:[^"\\\n]|\\(?:\r?\n|[^\n]))*"?|'(?:[^'\\\n]|\\(?:\r?\n|[^\n]))*'?)*`, "g");
/**
 * -p 后面的值：shell 的一个词，到引号外的空白为止。带引号的到闭引号（认 \" \' 这种转义、引号里行尾 \ 续行；没闭合就到段尾），
 * 引号前后紧接着的字也算（-p'x'tail、-pa"b c"d：bash 会接成同一个词），引号外 \ 转义的空白也算（-pMy\ Secret）。
 */
const P_VALUE = String.raw`(?!\[REDACTED\])(?!\\\r?\n)(?:\\(?:\r?\n|[^\n])|"(?:[^"\\\n]|\\(?:\r?\n|[^\n]))*"?|'(?:[^'\\\n]|\\(?:\r?\n|[^\n]))*'?|[^\s"'\\])+`;

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
const maskCommands = (s: string, cmd: RegExp, arg: RegExp | CommandArgs, edits?: Edit[]): string => {
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
    // 值的引号没闭合时，P_VALUE 一直吃到段尾（引号里什么都吃，段里又没有换行），所以没闭合的值总在段尾，不用另外核对位置。
    const mask = (v: string): string => {
      open = openQuoteAtEnd(v);
      return SECRET_MASK;
    };
    let seg: string;
    if (typeof arg === "function") seg = arg(m[0], mask);
    else {
      arg.lastIndex = 0;
      seg = m[0].replace(arg, (v: string, keep: string) => `${keep}${mask(v.slice(keep.length))}`);
    }
    // 往后走到这个词的末尾（闭引号和紧连着的字）；走过的都吃掉，下一条命令从那里接着找，总共是线性的。
    const next = open === null ? end : wordEnd(s, end, open);
    if (edits && (next !== end || seg !== m[0])) edits.push({ at: m.index, len: next - m.index, to: seg });
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
/*
 * _ 在这里算词边界，所以 DB_PASSWORD、API_TOKEN_2 这种环境变量式的名字由键名本身认出来；只有 X_AUTH 要单独认
 * （auth 不在键名里，_auth 前面又是字母数字）。以前写成 [A-Z][A-Z0-9_]*_AUTH…：每个 _ 都能起跑、各扫到格子末尾，
 * 格子里是平方级的（A_ 重复 200KB 约 21ms）。现在每个起点只往后看定长的字，线性。
 */
const HEADER_KEY = new RegExp(String.raw`(?:(?:^|[^A-Za-z0-9])(?:${KEY_NAMES}|pass|pin|key)|[A-Za-z0-9]_auth)s?${DIGITS}(?![A-Za-z0-9])`, "i");
/**
 * 连写的格子（DBPASSWORD、dbpassword、SECRETKEY、Authtoken、Dbpassword）没有驼峰可拆、也没有词边界：只要里面含这些键名就算，
 * 不看大小写（Tokenizer、Secretary 会被误打，宁可误打）。key、pass 太常见（monkey、Keystone、passenger），不在里面。
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


/**
 * HEADER_KEY、HEADER_RUN（还有拆开驼峰以后的 HEADER_KEY）认得出的键名都含这里的某一段（不看大小写；拆驼峰只插空格，不会多出字）。
 * 一行里一段都没有就不用逐格试：很多个短格子、每行下面都跟着分隔行的表格，每格跑三五条正则，200KB 约 13ms。
 */
const HEADER_HINT = /pass|pin|pwd|secret|token|key|credential|auth|密码|口令|密钥|令牌/i;

/** 一行里是密钥类键名的那几格的下标（从小到大）。 */
const headerCols = (line: string): number[] => {
  if (!HEADER_HINT.test(line)) return [];
  const out: number[] = [];
  cells(line).forEach((c, k) => {
    const t = c.trim();
    // 空格子直接跳过（很多个 | 的行每格都跑两三条正则，200KB 约 30ms）。
    if (t.length === 0 || t.length > 128) return;
    // 拆开前后都试：拆开会把 PassWord、PassPhrase、PASSWord 这种整词切断（Pass Word），原样的也要认。
    // 连写的（DBPASSWORD、userpwd、Authtoken、Dbpassword）不论大小写都按 HEADER_RUN 认（Tokenizer、Secretary 会被误打）。
    if (HEADER_KEY.test(t) || HEADER_RUN.test(t)) out.push(k);
    else {
      const u = splitCamel(t);
      if (u !== t && HEADER_KEY.test(u)) out.push(k);
    }
  });
  return out;
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
  // 全按下标在 s 上扫，不切行、不建格子数组：三万多行的短表格上，每行切一次、拆一次、join 一次就要好几毫秒。
  // 按换行切成行：starts[k]、ends[k] 是第 k 行（不含换行符）。
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; ; ) {
    let j = i;
    for (; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (c === 10 || c === 13) break;
    }
    starts.push(i);
    ends.push(j);
    if (j >= s.length) break;
    i = s.charCodeAt(j) === 13 && s.charCodeAt(j + 1) === 10 ? j + 2 : j + 1;
  }
  const n = starts.length;
  const hasBar = (k: number): boolean => {
    for (let i = starts[k]; i < ends[k]; i++) if (s.charCodeAt(i) === 124) return true;
    return false;
  };
  // 分隔行一定含 - 或 =：先按字符找一遍，没有就不切行、不跑正则。
  const isRule = (k: number): boolean => {
    for (let i = starts[k]; i < ends[k]; i++) {
      const c = s.charCodeAt(i);
      if (c === 45 || c === 61) return TABLE_RULE.test(s.slice(starts[k], ends[k]));
    }
    return false;
  };
  /** 这张表的密钥列；inTable：已经读过表头。 */
  let cols = new Set<number>();
  let inTable = false;
  // 打过码的格子和中间没动的部分攒在数组里最后一次 join：一路 += 拼出来的字符串，后面第一条正则还要先把它摊平。
  const out: string[] = [];
  let last = 0;
  /**
   * 第 k 行里 cols 那几格整格打码（格子按没转义的 | 切，和 cells 一样；前后空白留着，空格子和已经打过的不动）。
   * 按这行的格子走（不按 cols 走）：cols 可能比这行宽得多（很宽的表头下面很多短行），每行的花销不超过这行的长度。
   */
  const maskRow = (k: number): void => {
    let col = 0;
    let from = starts[k];
    const end = ends[k];
    for (let i = from; i <= end; i++) {
      const c = i < end ? s.charCodeAt(i) : 124;
      if (c === 92 && i < end) {
        // 转义的下一个字符跳过；行尾的 \ 后面没有字符，下一轮照样走到行尾那格。
        i = Math.min(i + 1, end - 1);
        continue;
      }
      if (c !== 124) continue;
      if (cols.has(col)) {
        let x = from;
        let y = Math.min(i, end);
        while (x < y && isSpace(s.charCodeAt(x))) x++;
        while (y > x && isSpace(s.charCodeAt(y - 1))) y--;
        if (x < y && !(y - x === SECRET_MASK.length && s.startsWith(SECRET_MASK, x))) {
          out.push(s.slice(last, x), SECRET_MASK);
          last = y;
        }
      }
      col++;
      from = i + 1;
    }
  };
  // 每行只测一次是不是分隔行：这一行的结果留给下一轮当「这一行」用。
  let isRuleLine = isRule(0);
  for (let k = 0; k < n; k++) {
    const ruleBelow = k + 1 < n && isRule(k + 1);
    if (!isRuleLine) {
      if (!hasBar(k)) {
        cols = new Set();
        inTable = false;
      } else if (!inTable) {
        if (ruleBelow) {
          inTable = true;
          cols = new Set(headerCols(s.slice(starts[k], ends[k])));
        }
      } else {
        if (cols.size > 0) maskRow(k);
        // 只往集合里加这行的键名列（不重建、不排序）：很宽的表头下面每行都并一次时，重建是平方级（200KB 约 8s）。
        if (ruleBelow) for (const c of headerCols(s.slice(starts[k], ends[k]))) cols.add(c);
      }
    }
    isRuleLine = ruleBelow;
  }
  if (last === 0) return s;
  out.push(s.slice(last));
  return out.join("");
};

/** Cookie 头的开头（Cookie:、Set-Cookie:，冒号也可以是全角「：」），和在它前面停下的先行断言。 */
const COOKIE = String.raw`\b(?:Set-)?Cookie\s*[:：]`;
const NOT_COOKIE = `(?!${COOKIE})`;

/** 命令行里的 -u / --user：后面可以是空白、\ 续行或 =。 */
const CLI_USER = String.raw`(?:^|\s)(?:-u|--user)(?:(?:\s|\\\r?\n)+|=)?`;
/** 命令行里的 --password、--token 之类：后面是空白、\ 续行或 =（= 后面也可以续行）。 */
const CLI_SECRET = String.raw`(?:^|\s)--?(?:password|passwd|pass|passphrase|token|api-key|apikey|secret|auth-token)(?:(?:\s|\\\r?\n)+|=${CONT})`;
/**
 * 单独的 pass、pin 键（还有 pinCode、pin_number、pass-no）：前面（隔着可选的引号、* _）不能连着字母数字，只认冒号、等号。从 pass / pin 起跑、往回看前面：
 * 写成先看前面再匹配可选引号的话，每个位置都要起跑一次（200KB 每条约 0.5ms）。
 */
const PASS_KEY = String.raw`(?<![A-Za-z0-9]${KQ})(?:pass|pin)(?:[_-]?(?:code|number|no))?${ENV_SEP}`;
/** k8s env 的 name 里含这些就算密钥。 */
const K8S_SECRET_NAME = /name[ \t]*:[ \t]*["']?[A-Za-z0-9_.-]*(?:pass|pwd|secret|token|key|credential|auth|dsn)/i;

/**
 * 块标量：匹配到的是开头的空行、再加缩进不比第一个非空行浅的那几行（中间的空行算进去）。开头的空行和值一起换成占位符，
 * 占位符的缩进取第一个非空行的；块末尾的空行原样留着（属于后面的内容）。
 */
function maskBlockScalar(h: Hit): string {
  const v = h.value;
  const keep = h.match.slice(0, h.match.length - v.length);
  // 正则只收开头的空行、缩进不少于第一个非空行的行和空行，所以整块都是值。不切行：一万个块也是线性的。
  let lineStart = 0;
  let first = 0;
  while (v[first] === " " || v[first] === "\t" || v[first] === "\r" || v[first] === "\n") {
    if (v[first] === "\n") lineStart = first + 1;
    first++;
  }
  let j = v.length;
  while (j > 0 && " \t\r\n".includes(v[j - 1])) j--;
  let lineEnd = j;
  while (lineEnd < v.length && v[lineEnd] !== "\n") lineEnd++;
  const tail = lineEnd > j && v[lineEnd - 1] === "\r" ? "\r" : "";
  return `${keep}${v.slice(lineStart, first)}${SECRET_MASK}${tail}${v.slice(lineEnd)}`;
}

/** 命令里的一个 shell 词（和 P_VALUE 一样的读法）、词之间的空白（行尾 \\ 续行也算空白）。sticky，一个接一个往后读。 */
const SHELL_WORD = new RegExp(String.raw`(?:\\(?:\r?\n|[^\n])|"(?:[^"\\\n]|\\(?:\r?\n|[^\n]))*"?|'(?:[^'\\\n]|\\(?:\r?\n|[^\n]))*'?|[^\s"'\\])+`, "y");
const SHELL_GAP = /(?:\s|\\\r?\n)+/y;
/**
 * htpasswd -b（批处理，口令在命令行上）：一个词一个词地读（线性，不用正则回溯），从口令那个位置参数一直打到重定向前的最后一个词。
 * 选项在位置参数前面，可以连写（-bc、-nbB）；-C、-r 带一个值（-C 10、-bBC 10）。有 -n 时没有文件参数（用户、口令），
 * 否则是文件、用户、口令；只有两个位置参数又没有 -n 的也打最后一个（宁可多打）。读到重定向（> f、2> f、>f、< f）就停。
 */
const REDIRECT = /\d*[<>]/y;
const htpasswdArgs: CommandArgs = (seg, mask) => {
  // 只记位置参数的起止（不为每个词建对象、切字符串）：两万个词的段也只扫一遍。
  const starts: number[] = [];
  const ends: number[] = [];
  let batch = false;
  let noFile = false;
  let options = true;
  let skip = true; // 第一个词是命令名本身；-C、-r 后面那个词是它的值
  let i = 0;
  while (i < seg.length) {
    SHELL_GAP.lastIndex = i;
    if (SHELL_GAP.test(seg)) {
      i = SHELL_GAP.lastIndex;
      continue;
    }
    SHELL_WORD.lastIndex = i;
    if (!SHELL_WORD.test(seg)) break;
    const start = i;
    const end = SHELL_WORD.lastIndex;
    i = end;
    if (skip) {
      skip = false;
      continue;
    }
    REDIRECT.lastIndex = start;
    if (REDIRECT.test(seg)) break;
    if (options && seg.charCodeAt(start) === 45 /* - */) {
      if (end - start === 2 && seg.charCodeAt(start + 1) === 45) {
        options = false;
        continue;
      }
      let k = start + 1;
      while (k < end && /[A-Za-z0-9]/.test(seg[k])) k++;
      if (k === end && end > start + 1) {
        for (let c = start + 1; c < end; c++) {
          if (seg[c] === "b") batch = true;
          else if (seg[c] === "n") noFile = true;
        }
        if (seg[end - 1] === "C" || seg[end - 1] === "r") skip = true;
        continue;
      }
    }
    options = false;
    starts.push(start);
    ends.push(end);
  }
  if (!batch || starts.length < 2) return seg;
  // 从口令那个位置参数一直到重定向前的最后一个词，整段打成一个占位符：多出来的参数也盖住，又不会每个词一个占位符把输出撑长。
  const from = starts[noFile ? 1 : Math.min(2, starts.length - 1)];
  const to = ends[ends.length - 1];
  return seg.slice(0, from) + mask(seg.slice(from, to)) + seg.slice(to);
};

const RULES: Rule[] = [
  // 私钥 / 证书块：BEGIN 到 END 整段（没有 END 就到结尾）。
  { re: /-----BEGIN[^-]{0,60}-----[\s\S]*?(?:-----END[^-]{0,60}-----|$)/g },
  // 剩下的 BEGIN 行头。
  { re: /-----BEGIN[^-]{0,60}-----/g },
  // YAML 的块标量（password: |、token: >-）：值在下面缩进的几行里，整块打成一个占位符。开头的空行跳过（每行都要吃掉一个换行，
  // 不会回溯），第一个非空行的缩进记下来（第 2 个捕获组），
  // 后面的行要以同样的缩进开头（不比第一行浅），中间的空行算进块里；缩进一变浅，块就到头了，匹配停在那里，下一次从那一行
  // 接着找（嵌套 mapping 里挨着的第二个块 token: | 照样认）。每个匹配只吃掉它自己的块，线性。
  { keyed: true, re: new RegExp(String.raw`(${KEY}${KQ}[ \t]*:[ \t]*[|>][-+1-9]{0,2}[ \t]*\r?\n)(?!\s*\[REDACTED\])(?:[ \t]*\r?\n)*([ \t]+)[^ \t\r\n][^\r\n]*(?:\r?\n(?:\2[^\r\n]*|[ \t]*(?=\r?\n|$)))*`, "gi"), mask: maskBlockScalar },
  // Kubernetes 的 env：- name: DB_PASSWORD 下一行 value: hunter2xyz。name 里含键名的（PASSWORD、TOKEN、SECRET、KEY、DSN…），value 后面整行打掉。
  {
    re: /(\bname[ \t]*:[ \t]*["']?[A-Za-z0-9_.-]{1,128}["']?[ \t]*\r?\n[ \t]*value[ \t]*:[ \t]*)(?!\[REDACTED\])[^\s#][^\r\n]*/g,
    skip: (h) => !K8S_SECRET_NAME.test(h.match.slice(0, h.match.length - h.value.length)),
  },
  // 键后面的值在引号里（"、'、`）：到同一个闭引号整段打掉（"my secret phrase"、'ab'）。要在别的规则之前：不然值里先被换进占位符，剩下的字就漏了。
  { keyed: true, re: new RegExp(`(${KEY}${SEP}${EMPTY_Q}${OPEN})${QUOTED}`, "gi") },
  { re: new RegExp(`(${ENV_KEY}${ENV_SEP}${EMPTY_Q}${OPEN})${QUOTED}`, "g") },
  { re: new RegExp(`(\\bkey${DIGITS}${ENV_SEP}${EMPTY_Q}${OPEN})${QUOTED}`, "gi"), skip: (h) => plainKeyValue(h.value) },
  { keyed: true, re: new RegExp(`(${NOT_AFTER_ALNUM}${KEY}${KQ}\\s+is\\s*(?:[:：]\\s*)?${EMPTY_Q}${OPEN})${QUOTED}`, "gi") },
  { re: new RegExp(`(${TABLE_KEY}${EMPTY_Q}${OPEN})${QUOTED}`, "gi") },
  { re: new RegExp(`(${PASS_KEY}${EMPTY_Q}${OPEN})${QUOTED}`, "gi") },
  // 引号没闭合、值里有空格（password: "two words、password = 'hunter 2）：照 mysql 的做法打到行尾。闭合了的上面已经打过，
  // 占位符跳过。同一种引号之间不会重叠着扫，总共是线性的。
  { keyed: true, re: new RegExp(`(${KEY}${SEP}${EMPTY_Q}${OPEN})${UNCLOSED}`, "gi") },
  { re: new RegExp(`(${ENV_KEY}${ENV_SEP}${EMPTY_Q}${OPEN})${UNCLOSED}`, "g") },
  // 「X is '…」引号没闭合：和 key: '… 一样打到行尾（以前只打第一个词，没冒号的连第一个词都不打）。
  { keyed: true, re: new RegExp(`(${NOT_AFTER_ALNUM}${KEY}${KQ}\\s+is\\s*(?:[:：]\\s*)?${EMPTY_Q}${OPEN})${UNCLOSED}`, "gi") },
  // 闭引号后面紧跟着字（password: 'abc'def123、TOKEN='abc'"def"：shell 里是同一个词）：接着打到这个词结束，闭引号留着。
  // 只接在上面打过码的引号值后面；后面又是一段引号的整段算进去（没闭合的到行尾）。每个字只有一种走法，线性。
  { re: /(\[REDACTED\]["'`”’」』])(?:[^\s，。；,;、)\]}>|"'`“”‘’「」『』]|"[^"\r\n]*"?|'[^'\r\n]*'?|`[^`\r\n]*`?|“[^”\r\n]*”?|‘[^’\r\n]*’?|「[^」\r\n]*」?|『[^』\r\n]*』?)+/g },
  // URL 里的账号密码：scheme://user:pass@host，只换密码段。用户名可以是空的（redis://:pw@host）；密码里不认裸 /（要写成 %2F）。
  // 冒号后面是纯数字再接 / 的是端口（localhost:5173/@vite/client）。长度设上限：很多个 :// 时不会每个都扫到结尾。
  // 密码段用「先行断言 + 反向引用」一次取到最长、不回溯（密码里没有 @，后面不是 @ 就肯定不是）。
  // 全角冒号也算（postgres://admin：S3cretPw＠db，＠ 已经换成半角）。
  { re: /(:\/\/[^\s:：@/]{0,256}[:：])(?!\[REDACTED\])(?!\d+\/)(?=([^\s@/]{1,256}))\2(?=@[^\s@/])/g },
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
  // 别的 scheme（token、Bot、Token、Negotiate…）或者没写 scheme 的 Authorization: 值，8 个字以上整段打掉（Authorization: required 也会被打，宁可误打）。
  { re: /(\bAuthorization["']?\s{0,16}[:=：]\s{0,16}["']?(?:[A-Za-z][A-Za-z0-9_-]{0,31}\s+)?)(?!\[REDACTED\])[^\s"',;]{8,}/gi },
  // Cookie 头：打掉 name=value; name=value 这一串，后面的话留着。名字限 128 字：不然很多个 Cookie: 时每个都扫到结尾。
  // 名字扫到下一个能起跑的 Cookie: 就停（NOT_COOKIE）：不然很多个挨着的 Cookie: 每个都往后扫 128 字再失败，200KB 约 8ms（CI 上翻几倍）。
  // 停下来的那一段交给下一个 Cookie: 自己去打。
  { re: new RegExp(String.raw`(${COOKIE}\s*)(?!\[REDACTED\])(?:${NOT_COOKIE}[^\s=;]){1,128}=[^\s;]*(?:;\s*[^\s=;]{1,128}=[^\s;]*)*`, "gi") },
  // 后面没有 name=：退回到打掉带数字的长串（Cookie: abc123secretvalue）。先行断言限 128 字，也是扫到下一个 Cookie: 就停。
  { re: new RegExp(String.raw`(${COOKIE}\s*)(?!\[REDACTED\])(?=(?:${NOT_COOKIE}[^\s;]){0,128}\d)(?=(?:${NOT_COOKIE}[^\s;]){0,128}[A-Za-z])[^\s;]{8,}`, "gi") },
  // 命令行：curl -u user:pass / --user user:pass 只换密码；--password xxx、--token xxx（空格或 = 分隔）；docker login -p xxx；
  // mysql -pxxx / -p'two words'（只认 mysql、mysqldump、mariadb、mysqladmin 后面的 -p：mkdir -pv、gcc -pthread 不算）；
  // sshpass -p xxx（-p 和值之间可以有空格）。引号没闭合的到行尾。
  // 值在引号里、带空格的（--password "S3cret Pw"、-u 'admin:S3cret Pw'）：整段打到闭引号（没闭合的到行尾），排在只打一个词的规则前面。
  // 用户名最长 256 字：很多个 -u " 都没有冒号时，每个最多往后看 256 字。
  { re: new RegExp(String.raw`(${CLI_USER}"[^:："\\\r\n]{0,256}[:：])(?!\[REDACTED\])(?:[^"\\\r\n]|\\[\s\S])+`, "g") },
  { re: new RegExp(String.raw`(${CLI_USER}'[^:：'\r\n]{0,256}[:：])(?!\[REDACTED\])[^'\r\n]+`, "g") },
  { re: new RegExp(String.raw`(${CLI_SECRET}")(?!\[REDACTED\])(?:[^"\\\r\n]|\\[\s\S])+`, "gi") },
  { re: new RegExp(String.raw`(${CLI_SECRET}')(?!\[REDACTED\])[^'\r\n]+`, "gi") },
  { re: new RegExp(String.raw`(${CLI_USER}["']?[^\s:："']*[:：]${CONT})(?!\[REDACTED\])(?!\\\r?\n)[^\s"']+`, "g") },
  { re: new RegExp(String.raw`(${CLI_SECRET}["']?)(?!\[REDACTED\])(?!\\\r?\n)[^\s"']+`, "gi") },
  { re: command(String.raw`docker\s+login`), arg: new RegExp(String.raw`(\s-p(?:\s|\\\r?\n)*)${P_VALUE}`, "g") },
  { re: command("mysql|mysqldump|mariadb|mysqladmin"), arg: new RegExp(String.raw`(\s-p(?:\\\r?\n)*)${P_VALUE}`, "g") },
  { re: command("sshpass"), arg: new RegExp(String.raw`(\s-p(?:\s|\\\r?\n)*)${P_VALUE}`, "g") },
  // gh secret set NAME --body x / -b x；openssl 的 -k x、-pass / -passin / -passout pass:x（引号里的 "pass:a b"、env:X 整个打）；ssh-keygen 的 -N / -P（新、旧口令）；
  // aws configure set 键名里有 secret / token / password / key 的；htpasswd -b（批处理，口令在命令行上）的最后一个位置参数。
  { re: command(String.raw`gh\s+secret\s+set`), arg: new RegExp(String.raw`(\s(?:--body(?:=|(?:\s|\\\r?\n)+)|-b(?:\s|\\\r?\n)*))${P_VALUE}`, "g") },
  { re: command("openssl"), arg: new RegExp(String.raw`(\s(?:-k(?:\s|\\\r?\n)+|-pass(?:in|out)?(?:\s|\\\r?\n)+(?:pass:)?))${P_VALUE}`, "g") },
  { re: command("ssh-keygen"), arg: new RegExp(String.raw`(\s-[NP](?:\s|\\\r?\n)*)${P_VALUE}`, "g") },
  {
    re: command(String.raw`aws\s+configure\s+set`),
    arg: new RegExp(String.raw`(\s(?=[\w.-]{0,64}?(?:secret|token|password|key))[\w.-]+(?:\s|\\\r?\n)+)${P_VALUE}`, "gi"),
  },
  { re: command("htpasswd"), arg: htpasswdArgs },
  // --password-stdin 的口令从 here-string（<<< x）或前面的 echo x | 进来。往后、往前都只看 128 字，线性。
  // <<< 后面的值按 shell 的一个词读（P_VALUE）：引号里带空格、转义的引号（"hun\"ter 2"）、$'…'、几段引号连写（'a'"b c"）整个打，没闭合的到行尾。
  { re: new RegExp(String.raw`(--password-stdin\b[^\n|;&]{0,128}?<<<[ \t]*)${P_VALUE}`, "g") },
  // 值用「先行断言 + 反向引用」一次取到整个词、不回溯（不然很长的词后面没有 | 时，每个字都要回退着再试一遍）。
  { re: /(\becho[ \t]+["']?)(?!\[REDACTED\])(?!\$)(?=([^\s"'|]+))\2(?=["']?[ \t]*\|[^\n|]{0,128}--password-stdin)/g },
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
  { keyed: true, re: new RegExp(`(${KEY}${SEP}${EMPTY_Q}${VQ})${VAL}`, "gi") },
  // 环境变量式的键（区分大小写，免得 primary_key: id 被当成密钥）。
  { re: new RegExp(`(${ENV_KEY}${ENV_SEP}${EMPTY_Q}${VQ})${VAL}`, "g") },
  // 单独的 key（key=…、"key": …、表格里的 | key | …）：前面不能连着字母、数字、_（primary_key、monkey 不算）。
  { re: new RegExp(`(\\bkey${DIGITS}${ENV_SEP}${EMPTY_Q}${VQ})${VAL}`, "gi"), skip: (h) => plainKeyValue(h.value) },
  // 单独的 pass、pin（nodemailer 的 { user, pass }、{"pin": "4821"}、smtp 配置）：前面不能连着字母数字（bypass、spin 不算）。
  { re: new RegExp(`(${PASS_KEY}${EMPTY_Q}${VQ})${VAL}`, "gi") },
  // Markdown 表格：| password | hunter2xyz |。
  { re: new RegExp(`(${TABLE_KEY}${EMPTY_Q}${VQ})${VAL}`, "gi") },
  // 「token abc…」「secret abc…」：键后面隔一个空格跟着一长串（16 位以上，有字母也有数字）。
  { re: /(\b(?:token|secret|password|passwd|api[_ -]?key)\s+)(?!\[REDACTED\])(?=[A-Za-z0-9._~+/=-]*\d)(?=[A-Za-z0-9._~+/=-]*[A-Za-z])[A-Za-z0-9._~+/=-]{16,}/gi },
  // 「the password is: x」：带冒号的照打。
  { keyed: true, re: new RegExp(`(${NOT_AFTER_ALNUM}${KEY}${KQ}\\s+is\\s*[:：]\\s*${EMPTY_Q}${VQ})${VAL_ANY}`, "gi") },
  // 「the password is hunter2xyz」「token is "abc123def」（引号没闭合）：值里要有数字或符号，免得「the token is expired」
  // 「… is expired.」「the token is user's」这种话被打码（句末的 . 不算；! ? 算，宁可误打）。
  {
    keyed: true,
    re: new RegExp(`(${NOT_AFTER_ALNUM}${KEY}${KQ}\\s+is\\s+${EMPTY_Q}${VQ})${VAL}`, "gi"),
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

/**
 * 规则本来就认的全角标点（：当分隔符，，；当值的结尾，！？（）和半角的一样算进值）：不用换，原样留着，中文的话不变样。
 * 「：」不换成半角：它在 URL 后面是 URL 的边界（https://x/a：长串，长串照打；换成 : 就成了路径的一部分、只打像 token 的段）。
 * 要它当冒号的规则（URL 里的账号密码、curl -u）自己把 ： 也认成冒号。
 */
const KEPT_FULLWIDTH = "！（），：；？";
/** 竖线类框线字符换成 |，横线换成 -，别的（交叉、拐角、T 形）换成 +：psql 的 unicode 边框变成 mysql 那种 +---+、| a |。 */
const BOX_V = [..."│┃║╎╏┆┇┊┋"].map((c) => c.charCodeAt(0));
const BOX_H = [..."─━═╌╍┄┅┈┉"].map((c) => c.charCodeAt(0));
/**
 * BMP 里 Default_Ignorable_Code_Point 的全部范围（软连字符 U+00AD、零宽字符、U+2061–2064 这类不可见的运算符、方向控制符、
 * 变体选择符、U+FEFF…）：去掉。和 \p{Default_Ignorable_Code_Point} 逐个核对过（secrets.test.ts）。
 */
const IGNORABLE_BMP: [number, number][] = [
  [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff0, 0xfff8],
];
/** BMP 以外的 Default_Ignorable_Code_Point：U+1BCA0–1BCA3、U+1D173–1D17A、U+E0000–E0FFF（标签字符、变体选择符补充）。 */
const isIgnorableAstral = (cp: number): boolean => (cp >= 0x1bca0 && cp <= 0x1bca3) || (cp >= 0x1d173 && cp <= 0x1d17a) || (cp >= 0xe0000 && cp <= 0xe0fff);
/**
 * NFKC 换成单个 ASCII 字母或数字的兼容字符：上下标（ᵖ ⁿ ₐ ¹ ₂）、字母式符号（ℙ ℎ）、数字形式（ⅰ）、带圈字母（ⓟ）。
 * 上下标数字要换：键名后面的编号（token₁=、password²=）换成 token1、password2 才认得出。但一串兼容数字后面紧跟字母、数字、_
 * （按换完以后算，去掉的不可见字跳过）时不换（20531347 复核 MF2）：「注¹mysql -pX」「x²ghp_…」「₂token is X」换成 1mysql、2ghp_
 * 就和后面的词粘在一起，\b 认不出词头，整条漏打；不换的话 ¹ 不是 \w，后面的词照常认得出。
 * 例外是换完以后正好是一个键的一部分（keyDigits：KEY 的编号或者单词后缀里的数字、单独的 key 的编号、ENV 式的键，后面还接着分隔符）：
 * token₁_prod=、PASSWORD²_DB=、password²abc=、MY₁_TOKEN= 照换，换完才是键名加编号加后缀（c067e822 复核必修 2）；前面是键名、后面却不是键的
 * （token²ghp_…、password¹mysql -p…）不换（adf2412e 复核必修 B）。只看这一串前后几十个字，每一串只判一次（必修 A：线性）。一串数字中间夹的零宽字符、软连字符不打断这一串（token₁、零宽空格、₂= 是 token12=）。
 * 带圈、带框的（U+2460–24FF、U+1F100–1F1FF）只换字母：① ⑴ ⒈ 🄁 → 1 会和后面的词粘在一起，\b 认不出词头
 * （「步骤：①mysql -pX」「①ghp_…」）。换成几个字或符号的（™ → TM、℡ → TEL、ﬁ → fi、℃ → °C）也不动（「配置™Bearer …」）；
 * 键名里本来就没有连字。模块加载时按块算一遍（约一千五百个字）。
 */
const COMPAT_BLOCKS: [number, number][] = [[0xb2, 0xb3], [0xb9, 0xb9], [0x1d2c, 0x1dbf], [0x2070, 0x209f], [0x2100, 0x218f], [0x2460, 0x24ff]];
/** 带圈、带框的字：只换字母，不换数字。 */
const isEnclosed = (cp: number): boolean => (cp >= 0x2460 && cp <= 0x24ff) || (cp >= 0x1f100 && cp <= 0x1f1ff);
/** BMP 以外换成 ASCII 的兼容字符：数学字母数字符号（𝐩𝐚𝐬𝐬 粗体、斜体、等宽…）、带圈 / 带框字母补充（🄿）。用到时再算，记下来。 */
const isCompatAstral = (cp: number): boolean => (cp >= 0x1d400 && cp <= 0x1d7ff) || (cp >= 0x1f100 && cp <= 0x1f1ff);
const asciiCompat = (cp: number): string | null => {
  const n = String.fromCodePoint(cp).normalize("NFKC");
  return /^[A-Za-z]$/.test(n) || (/^[0-9]$/.test(n) && !isEnclosed(cp)) ? n : null;
};

/** 每个 BMP 字怎么换：KEEP 不动，SHIFT 全角换半角，DROP 去掉，TO 查 BMP_TO，HIGH 是代理对的前半。查表比一串范围判断快（200KB 的中文约 1ms）。 */
const KEEP = 0;
const SHIFT = 1;
const DROP = 2;
const TO = 3;
const HIGH = 4;
const KIND = new Uint8Array(0x10000);
const BMP_TO = new Map<number, string>();
/** BMP_TO 的同一份，按字符码存（都是一个 ASCII 字）：keyDigits 往回、往前看时不建字符串。 */
const TO_CODE = new Uint16Array(0x10000);
for (let c = 0xff01; c <= 0xff5e; c++) if (!KEPT_FULLWIDTH.includes(String.fromCharCode(c))) KIND[c] = SHIFT;
for (const [lo, hi] of IGNORABLE_BMP) for (let c = lo; c <= hi; c++) KIND[c] = DROP;
for (let c = 0x2500; c <= 0x257f; c++) {
  KIND[c] = TO;
  BMP_TO.set(c, BOX_V.includes(c) ? "|" : BOX_H.includes(c) ? "-" : "+");
  TO_CODE[c] = BMP_TO.get(c)!.charCodeAt(0);
}
for (const [lo, hi] of COMPAT_BLOCKS) {
  for (let c = lo; c <= hi; c++) {
    const to = asciiCompat(c);
    if (to !== null) {
      KIND[c] = TO;
      BMP_TO.set(c, to);
      TO_CODE[c] = to.charCodeAt(0);
    }
  }
}
for (let c = 0xd800; c <= 0xdbff; c++) KIND[c] = HIGH;
const ASTRAL_TO = new Map<number, string | null>();
const astralTo = (cp: number): string | null => {
  let t = ASTRAL_TO.get(cp);
  if (t === undefined) {
    t = asciiCompat(cp);
    ASTRAL_TO.set(cp, t);
  }
  return t;
};
const isDigit = (t: string | null | undefined): boolean => t !== null && t !== undefined && t.length === 1 && t >= "0" && t <= "9";
const isWordChar = (t: string | null | undefined): boolean => t !== null && t !== undefined && t.length === 1 && /[A-Za-z0-9_]/.test(t);
const codePointAt = (s: string, i: number): number => {
  const c = s.charCodeAt(i);
  const d = s.charCodeAt(i + 1);
  return d >= 0xdc00 && d <= 0xdfff ? (c - 0xd800) * 0x400 + (d - 0xdc00) + 0x10000 : -1;
};
/** s[i] 是换成数字的兼容字符（₁ ² 𝟏）：返回它占几个 UTF-16 单元，不是返回 0。全角数字（１）不算，照常换。 */
function compatDigitWidth(s: string, i: number): number {
  const c = s.charCodeAt(i);
  const kind = KIND[c];
  if (kind === TO) return isDigit(BMP_TO.get(c)) ? 1 : 0;
  if (kind !== HIGH) return 0;
  const cp = codePointAt(s, i);
  return cp >= 0 && isCompatAstral(cp) && isDigit(astralTo(cp)) ? 2 : 0;
}
/** s[j] 是会被去掉的不可见字（零宽字符、软连字符、BMP 以外的可忽略字）：返回它占几个 UTF-16 单元，不是返回 0。 */
function droppedWidth(s: string, j: number): number {
  const kind = KIND[s.charCodeAt(j)];
  if (kind === DROP) return 1;
  if (kind !== HIGH) return 0;
  const cp = codePointAt(s, j);
  return cp >= 0 && isIgnorableAstral(cp) ? 2 : 0;
}
/** 从 i 起一串兼容数字（中间可以夹会被去掉的字）到哪里为止（最后一个数字后面）；i 上不是兼容数字就是 i。 */
function compatDigitsEnd(s: string, i: number): number {
  let end = i;
  for (let j = i; ; ) {
    const w = compatDigitWidth(s, j);
    if (w > 0) {
      j += w;
      end = j;
      continue;
    }
    const d = end > i ? droppedWidth(s, j) : 0;
    if (d === 0) return end;
    j += d;
  }
}
/** mappedCode 的两种特殊结果：这个字去掉了；BMP 以外不换的字（不会是键名、分隔符的一部分）。 */
const GONE = -1;
const OTHER = 0x10000;
/** 一个字换完以后的字符码（不换的原样）；只给 keyDigits 往回、往前看用，不建字符串。 */
function mappedCode(c: number, cp: number): number {
  if (cp >= 0x10000) {
    if (isIgnorableAstral(cp)) return GONE;
    const t = isCompatAstral(cp) ? astralTo(cp) : null;
    return t === null ? OTHER : t.charCodeAt(0);
  }
  if (c < 0xad) return c;
  const kind = KIND[c];
  if (kind === SHIFT) return c - 0xfee0;
  if (kind === DROP) return GONE;
  if (kind === TO) return TO_CODE[c];
  return c;
}
/** prevMapped / nextMapped 读完的那个字的开头 / 结尾（省得每次返回一对值）。 */
let readAt = 0;
/** s 里 k 前面那个字（代理对算一个）换完以后的字符码；readAt 设成它的开头。 */
function prevMapped(s: string, k: number): number {
  const c = s.charCodeAt(k - 1);
  if (c >= 0xdc00 && c <= 0xdfff && k >= 2) {
    const h = s.charCodeAt(k - 2);
    if (h >= 0xd800 && h <= 0xdbff) {
      readAt = k - 2;
      return mappedCode(h, (h - 0xd800) * 0x400 + (c - 0xdc00) + 0x10000);
    }
  }
  readAt = k - 1;
  return mappedCode(c, c);
}
/** s 里从 j 起的那个字换完以后的字符码；readAt 设成它的结尾。 */
function nextMapped(s: string, j: number): number {
  const c = s.charCodeAt(j);
  if (c >= 0xd800 && c <= 0xdbff) {
    const d = s.charCodeAt(j + 1);
    if (d >= 0xdc00 && d <= 0xdfff) {
      readAt = j + 2;
      return mappedCode(c, (c - 0xd800) * 0x400 + (d - 0xdc00) + 0x10000);
    }
  }
  readAt = j + 1;
  return mappedCode(c, c);
}
/** 换完以后是数字、或者去掉了（零宽字符夹在数字中间不打断这一串）。 */
const digitOrGone = (t: number): boolean => t === GONE || (t >= 48 && t <= 57);

/** 倒着存的字典树：从键名的最后一个字往前走。键是字的 UTF-16 码（ASCII 字母转小写）。 */
interface Trie {
  next: Map<number, Trie>;
  end: boolean;
}
function trieOf(words: Iterable<string>): Trie {
  const root: Trie = { next: new Map(), end: false };
  for (const w of words) {
    let n = root;
    for (let i = 0; i < w.length; i++) {
      const c = w.charCodeAt(i);
      let m = n.next.get(c);
      if (!m) {
        m = { next: new Map(), end: false };
        n.next.set(c, m);
      }
      n = m;
    }
    n.end = true;
  }
  return root;
}
/** 把 KEY_NAMES 的一个分支展开成全部字面写法（里面只有 [_ -]? 和 [_ ] 这种字符组）；剩下别的正则写法就报错，别悄悄漏掉。 */
function spellings(p: string): string[] {
  const m = /\[([^\]]+)\](\?)?/.exec(p);
  if (!m) {
    if (/[\\()[\]?*+.{}^$|]/.test(p)) throw new Error(`KEY_NAMES 里有展不开的写法：${p}`);
    return [p];
  }
  const opts = [...m[1], ...(m[2] ? [""] : [])];
  return opts.flatMap((o) => spellings(p.slice(0, m.index) + o + p.slice(m.index + m[0].length)));
}
const reversed = (w: string): string => [...w].reverse().join("");
/** 键名（可以是复数）倒着读：数字串前面直接是它，或者后缀开头前面没有编号时用。 */
const KEY_NAME_BEFORE = trieOf(KEY_NAMES.split("|").flatMap(spellings).flatMap((name) => ["", "s"].map((pl) => pl + reversed(name))));
/** 键名、可选的 s、可选的 _ 或 -（DIGITS 的 [_-]）倒着读：编号前面用（和 KEY 里 `(?:${KEY_NAMES})s?(?:[_-]?\d+)?` 的前半段一样）。 */
const KEY_BEFORE_DIGITS = trieOf(
  KEY_NAMES.split("|").flatMap(spellings).flatMap((name) => ["", "_", "-"].flatMap((sep) => ["", "s"].map((pl) => sep + pl + reversed(name)))),
);
/**
 * s 里 p 前面（换完以后、ASCII 字母不分大小写）倒着走 trie，走到一个词尾就算。不设往回看的上限：去掉的字（键名中间夹的零宽字符）
 * 不算一步，别的字一对不上就停，所以最多走一个键名那么多个字；一大片零宽字符只有紧挨着它后面的这几个起点会走过（复核 adf2412e 必修 A、B）。
 */
function trieBefore(s: string, p: number, root: Trie): boolean {
  let n = root;
  let k = p;
  while (k > 0) {
    let c = prevMapped(s, k);
    k = readAt;
    if (c === GONE) continue;
    if (c >= 65 && c <= 90) c += 32;
    const m = n.next.get(c);
    if (!m) return false;
    n = m;
    if (n.end) return true;
  }
  return false;
}
/** s 里正好在 p 结束的是不是「键名 s? 编号?」（KEY 里后缀前面的那一段）。 */
function keyBefore(s: string, p: number): boolean {
  let k = p;
  let digits = false;
  // 编号多长都行（和 \d+ 一样）：调用方每一段字母数字只问一遍，问的几个位置前面的数字互不重叠，合起来还是线性的。
  while (k > 0) {
    const c = prevMapped(s, k);
    if (c !== GONE && !(c >= 48 && c <= 57)) break;
    if (c !== GONE) digits = true;
    k = readAt;
  }
  return trieBefore(s, k, digits ? KEY_BEFORE_DIGITS : KEY_NAME_BEFORE);
}
/** 单独的 key 后面的编号（`\bkey${DIGITS}`）：数字串前面是 key、key_ 或 key-，key 前面不连着字母、数字、_。 */
function plainKeyBefore(s: string, p: number): boolean {
  let k = p;
  let want = 0;
  const word = [121, 101, 107]; // y e k
  while (k > 0) {
    let c = prevMapped(s, k);
    k = readAt;
    if (c === GONE) continue;
    if (c >= 65 && c <= 90) c += 32;
    if (want === 0 && (c === 95 || c === 45)) {
      want = -1;
      continue;
    }
    if (want < 0) want = 0;
    if (c !== word[want]) return false;
    if (++want === 3) break;
  }
  if (want !== 3) return false;
  while (k > 0) {
    const c = prevMapped(s, k);
    k = readAt;
    if (c === GONE) continue;
    return !(isAlnumCode(c) || c === 95);
  }
  return true;
}
const isAlnumCode = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
/** JS 正则 \s 认的空白。 */
const isSpaceCode = (c: number): boolean =>
  c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
/** KQ 里的引号（* 和 _ 另判：可以连着两个）。 */
const QUOTE_CODES = new Set([..."\"'`“”‘’「」『』"].map((c) => c.charCodeAt(0)));
/** 后缀最多 1 个 _ 或 - 加 16 个字母数字。 */
const SUFFIX_MAX = 16;
/** 从 j 起跳过去掉的字，下一个字换完以后的字符码（到头了是 OTHER）；readAt 设成它的结尾。 */
function peekMapped(s: string, j: number): number {
  while (j < s.length) {
    const c = nextMapped(s, j);
    if (c !== GONE) return c;
    j = readAt;
  }
  readAt = j;
  return OTHER;
}
/** afterKey 认哪一种：KEY 的编号后面（还可以先跟一个单词后缀）、KEY 的后缀后面、ENV 式的键后面。 */
const AFTER_DIGITS = 0;
const AFTER_SUFFIX = 1;
const AFTER_ENV = 2;
/**
 * s 里 q 起（换完以后）是不是键后面该接的东西，按字符码一个个认，不建字符串、不跑正则：
 * - AFTER_SUFFIX：KQ（一个引号、* 或 **、_ 或 __，可选），再是 \s* 加 : = ： 是 为、\s+ 加 is、或者 [ \t]* 加 |
 *   （KEY_AT 的 `${KQ}(?:\s*(?:[:=：]|是|为)|\s+is)` 和 TABLE_KEY 的 `${KQ}[ \t]*\|`）；
 * - AFTER_DIGITS：前面还可以先有一个 KEY_SUFFIX（_ 或 - 加 1 到 16 个字母数字，或者字母开头的 1 到 16 个字母数字，到字母数字的尽头）；
 * - AFTER_ENV：KQ，再是 \s* 加 : = ：（ENV_SEP 的前半段）。
 * KQ 和后缀都只有一种读法：_ 后面紧跟字母数字的只能是后缀（当 KQ 的话后面就得是空白或分隔符），所以不用回溯。
 */
function afterKey(s: string, q: number, kind: number): boolean {
  let c = peekMapped(s, q);
  let j = readAt;
  if (kind === AFTER_DIGITS && (c === 95 || c === 45 || (c >= 65 && c <= 90) || (c >= 97 && c <= 122))) {
    let d = c;
    let k = j;
    if (c === 95 || c === 45) {
      d = peekMapped(s, k);
      k = readAt;
    }
    if (isAlnumCode(d)) {
      let run = 0;
      while (isAlnumCode(d)) {
        if (++run > SUFFIX_MAX) return false;
        d = peekMapped(s, k);
        k = readAt;
      }
      c = d;
      j = k;
    } else if (c !== 95) return false;
  }
  // KQ
  if (QUOTE_CODES.has(c)) {
    c = peekMapped(s, j);
    j = readAt;
  } else if (c === 42 || c === 95) {
    const first = c;
    c = peekMapped(s, j);
    j = readAt;
    if (c === first) {
      c = peekMapped(s, j);
      j = readAt;
    }
  }
  let spaces = 0;
  let tabs = true;
  // 空白不设上限（和 \s* 一样）：每串数字后面的这段空白只有它自己会走（下一串数字在这段空白后面），合起来还是线性的。
  while (isSpaceCode(c)) {
    spaces++;
    if (c !== 32 && c !== 9) tabs = false;
    c = peekMapped(s, j);
    j = readAt;
  }
  if (c === 58 || c === 61 || c === 0xff1a) return true;
  if (kind === AFTER_ENV) return false;
  if (c === 0x662f || c === 0x4e3a) return true;
  if (c === 124) return tabs;
  return spaces > 0 && (c | 32) === 105 && (peekMapped(s, j) | 32) === 115;
}
/**
 * sufRun 看过的那一段字母数字：到 sufRunEnd 为止、后面接不接得上键后面该接的（afterKey 的 AFTER_SUFFIX）、离结尾 16 个字母数字以内是从哪里起（sufRunFrom）、
 * 最靠前的一个能当 KEY 后缀开头的位置（sufRunKey，没有就是 Infinity；用到才算，还没算是 NaN）；normalize 每次开头清掉。
 */
let sufRunEnd = 0;
let sufRunOk = false;
let sufRunFrom = 0;
let sufRunKey = NaN;
/**
 * 数字串从 start 起在 KEY 的单词后缀里（tokenmonkey₁x=、tokens₁ᵃ=、token2x₁=、token12_₁x=）：这一段字母数字后面接着分隔符（AFTER_SUFFIX），
 * 后缀从这一段里一个字母起（字母开头的那种）、或者从这一段的开头起（_ - 开头的那种），到这一段结尾不超过 16 个字母数字，
 * 开头前面正好是「键名 s? 编号?」。sufRun 一段只走一遍（结尾、后面接不接得上、离结尾 16 个字的位置、最靠前的后缀开头都记下来，
 * 同一段里的数字串直接用），每个开头 keyBefore 也只看几十个字，所以 ₁a₁a… 这种也是线性的。
 */
function sufRun(s: string, start: number, end: number): void {
  if (start >= sufRunEnd) {
    let b = end;
    while (b < s.length) {
      const c = nextMapped(s, b);
      if (c !== GONE && !isAlnumCode(c)) break;
      b = readAt;
    }
    sufRunEnd = b;
    sufRunOk = afterKey(s, b, AFTER_SUFFIX);
    if (sufRunOk) {
      let k = b;
      let n = 0;
      while (k > 0) {
        const c = prevMapped(s, k);
        if (c !== GONE && (n === SUFFIX_MAX || !isAlnumCode(c))) break;
        if (c !== GONE) n++;
        k = readAt;
      }
      sufRunFrom = k;
    }
    sufRunKey = NaN;
  }
}
/** [from, b) 里最靠前的一个后缀开头：from 是这一段的开头、前面是 _ 或 -；或者一个字母。开头前面都要正好是「键名 s? 编号?」。 */
function suffixStart(s: string, from: number, b: number): number {
  let q = from;
  while (q > 0) {
    const c = prevMapped(s, q);
    if (c !== GONE) {
      if ((c === 95 || c === 45) && keyBefore(s, readAt)) return from;
      break;
    }
    q = readAt;
  }
  for (let j = from; j < b; ) {
    const c = nextMapped(s, j);
    const next = readAt;
    if (c >= 65 && keyBefore(s, j)) return j;
    j = next;
  }
  return Infinity;
}
function inKeySuffix(s: string, start: number): boolean {
  if (!sufRunOk) return false;
  if (Number.isNaN(sufRunKey)) sufRunKey = suffixStart(s, sufRunFrom, sufRunEnd);
  return sufRunKey <= start;
}
/** ENV 式的键：整段（换完以后）对上 \b[A-Z][A-Z0-9_]*ENV_TAIL，后面可以多一两个 _（KQ 的 __?）。 */
const ENV_WHOLE = new RegExp(String.raw`^[A-Z][A-Z0-9_]*${ENV_TAIL}_{0,2}$`);
const isWordCode = (c: number): boolean => isAlnumCode(c) || c === 95;
/** envRun 判过的那一段到 envRunEnd 为止、判出来是什么（同一段里的数字串直接用）；normalize 每次开头清掉。 */
let envRunEnd = 0;
let envRunOk = false;
/**
 * 数字串 [start, end) 所在的这一段字母数字 _（换完以后；ENV_KEY 前面有 \b，键里只有大写字母、数字、_，所以 ENV 式的键正好是一整段，
 * 最多去掉结尾一两个 _）是不是 ENV 式的键，后面接着冒号、等号：MY_SECRET²_X=、GITHUB_TOKEN₁_CI=、MY_API_KEY_2²_X=、MY₁_TOKEN=。
 * 每一段只走一遍、只判一次（这一段里后面的数字串直接用 envRunOk），所以 A₁A₁A₁… 这种也是线性的。
 */
function envRun(s: string, start: number, end: number): boolean {
  if (start < envRunEnd) return envRunOk;
  let a = start;
  while (a > 0) {
    const c = prevMapped(s, a);
    if (c !== GONE && !isWordCode(c)) break;
    a = readAt;
  }
  let b = end;
  let upper = true;
  while (b < s.length) {
    const c = nextMapped(s, b);
    if (c !== GONE && !isWordCode(c)) break;
    if (c >= 97) upper = false;
    b = readAt;
  }
  envRunEnd = b;
  envRunOk = false;
  if (!upper || !afterKey(s, b, AFTER_ENV)) return false;
  for (let k = a; k < start; ) {
    const c = nextMapped(s, k);
    k = readAt;
    if (c >= 97) return false;
  }
  let w = "";
  for (let k = a; k < b; ) {
    const c = nextMapped(s, k);
    k = readAt;
    if (c !== GONE) w += String.fromCharCode(c);
  }
  envRunOk = ENV_WHOLE.test(w);
  return envRunOk;
}
/**
 * 编号 [.., end) 后面是不是 KEY 剩下的部分（afterKey 的 AFTER_DIGITS）。后面紧跟字母的，只能是字母开头的后缀、一直到这一段字母数字的结尾：
 * 直接用 sufRun 记下的（不用每串都往后走 17 个字）。
 */
function keyAfterDigits(s: string, end: number): boolean {
  let j = end;
  while (j < s.length) {
    const c = nextMapped(s, j);
    if (c === GONE) {
      j = readAt;
      continue;
    }
    if (isAlnumCode(c)) return sufRunOk && end >= sufRunFrom;
    break;
  }
  return afterKey(s, end, AFTER_DIGITS);
}
/** keyDigits 判的那一整串数字的结尾。 */
let keyDigitsEnd = 0;
/**
 * 从 i 起的兼容数字所在的这一整串数字（ASCII 数字、全角数字、兼容数字连着，中间可以夹去掉的字）到 [start, end)，
 * 换成数字以后有没有一个键盖住它（复核 adf2412e 必修 B：只有这样才换；前面是键名、后面却不是键的 token²ghp_…、password¹mysql -p…
 * 不换，¹ 不是 \w，后面的词照常认得出）：
 * - 是 KEY 的编号：前面是「键名 s? [_-]?」，后面是 KEY 剩下的部分（token₁_prod=、PASSWORD²_DB=、token₁2=）；
 * - 是单独的 key 的编号（key₁=、KEY_₁_:）；
 * - 在 KEY 的单词后缀里（inKeySuffix）；
 * - 在 ENV 式的键里（envRun）。
 * 都只看这一串前后几十个字以内、每一串只判一次（复核 adf2412e 必修 A：线性）。这一串的结尾放在 keyDigitsEnd。
 */
function keyDigits(s: string, i: number): boolean {
  let start = i;
  while (start > 0 && digitOrGone(prevMapped(s, start))) start = readAt;
  let end = i;
  while (end < s.length && digitOrGone(nextMapped(s, end))) end = readAt;
  keyDigitsEnd = end;
  sufRun(s, start, end);
  if (trieBefore(s, start, KEY_BEFORE_DIGITS) && keyAfterDigits(s, end)) return true;
  if (plainKeyBefore(s, start) && afterKey(s, end, AFTER_SUFFIX)) return true;
  return inKeySuffix(s, start) || envRun(s, start, end);
}
/** 从 j 起、跳过会被去掉的字以后，下一个字换完以后是不是字母、数字或 _。 */
function nextIsWord(s: string, j: number): boolean {
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c < 0xad) return isWordChar(s[j]);
    const kind = KIND[c];
    if (kind === KEEP) return false;
    if (kind === SHIFT) return isWordChar(String.fromCharCode(c - 0xfee0));
    if (kind === TO) return isWordChar(BMP_TO.get(c));
    if (kind === DROP) {
      j++;
      continue;
    }
    const cp = codePointAt(s, j);
    if (cp < 0) return false;
    if (isIgnorableAstral(cp)) {
      j += 2;
      continue;
    }
    return isCompatAstral(cp) && isWordChar(astralTo(cp));
  }
  return false;
}

/**
 * 规范化：全角 ASCII（U+FF01–FF5E：ｐａｓｓｗｏｒｄ、＝、｜、＂、＠）换成半角（和 NFKC 对这一段的做法一样，KEPT_FULLWIDTH 除外），
 * 去掉 Default_Ignorable 的字（零宽字符、软连字符、U+2063…），框线字符（U+2500–257F，psql 的 │ ─ ┼）换成 | - +，
 * NFKC 换得成单个 ASCII 字母或数字的兼容字符（𝐩𝐚𝐬𝐬𝐰𝐨𝐫𝐝、ⓟ、₁、𝟏）换成那个字（一串兼容数字后面紧跟字母数字的不换，见 COMPAT_BLOCKS）。
 * 每个字换成一个 ASCII 字、或去掉，别的字不动。
 * 一个字一个字查表扫一遍，不用正则回调：每行一次回调的写法在三万多行的短表格上要 7ms（CI 上过了 50ms），这样约 1ms。
 * 一个要换的字都没有就返回原来那个串（调用方用 === 判断）。
 */
function normalize(s: string): string {
  let out = "";
  let last = 0;
  // 已经看过的一串兼容数字到 digitsEnd 为止；digitsMap：这一串换不换（后面不紧跟字母数字，或者换完是 KEY 的一部分）。
  let digitsEnd = 0;
  let digitsMap = true;
  // keyDigits 判过的那一整串数字到 keyEnd 为止、判出来是什么：同一串里后面的兼容数字直接用，不再往回、往前看。
  let keyEnd = 0;
  let keyMap = false;
  envRunEnd = 0;
  sufRunEnd = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // 要换的字都在 U+00AD 以后：ASCII 和常见的拉丁字母直接跳过。
    if (c < 0xad) continue;
    const kind = KIND[c];
    if (kind === KEEP) continue;
    if (kind === TO || kind === HIGH) {
      if (i >= digitsEnd) {
        const end = compatDigitsEnd(s, i);
        if (end > i) {
          digitsEnd = end;
          if (!nextIsWord(s, end)) digitsMap = true;
          else {
            if (i >= keyEnd) {
              keyMap = keyDigits(s, i);
              keyEnd = keyDigitsEnd;
            }
            digitsMap = keyMap;
          }
        }
      }
      // 这一串里的数字不换（夹在中间的不可见字照常去掉；BMP 以外的数字只跳过前半，后半在 KIND 里是 KEEP）。
      if (i < digitsEnd && !digitsMap && compatDigitWidth(s, i) > 0) continue;
    }
    let to: string;
    let width = 1;
    if (kind === SHIFT) to = String.fromCharCode(c - 0xfee0);
    else if (kind === DROP) to = "";
    else if (kind === TO) to = BMP_TO.get(c) ?? "";
    else {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) continue;
      const cp = (c - 0xd800) * 0x400 + (d - 0xdc00) + 0x10000;
      if (isIgnorableAstral(cp)) to = "";
      else if (isCompatAstral(cp)) {
        const t = astralTo(cp);
        if (t === null) {
          i++;
          continue;
        }
        to = t;
      } else {
        i++;
        continue;
      }
      width = 2;
    }
    out += s.slice(last, i) + to;
    last = i + width;
    i += width - 1;
  }
  return last === 0 ? s : out + s.slice(last);
}

/**
 * KEY 规则（keyed）能起跑的位置：后面是键名、可选的引号，再跟分隔符（: = ： 是 为）或「 is」。每条 KEY 规则的开头都是这一段
 * （YAML 块标量的「键:」、SEP、「键 is」），所以它们的匹配只会从这些位置开始。
 * 先用这一条零宽先行扫一遍，记下候选起点，8 条 KEY 规则只在这些起点上用 sticky 副本去试：不然每条规则都要在每个位置把 KEY 试一遍
 * （tokens_、pwds_、credentials_ 连着重复的 200KB，8 条加起来约 20ms，CI 上翻两三倍）。没有候选就整条跳过。
 * 只扫一次：后面哪条规则改了文本，就按它记下的每一处替换把候选起点挪过去（moveStarts），不整篇重扫
 * （复核 f780e9ef：每改一次就重扫的话，前面一小段让每条 KEY 规则都改一次，就是整篇扫 7–8 遍，CI 上 60–70ms；
 * 文本变了就退回整篇 replace 的话，同样的前缀接 PWDS_ 重复 200KB 是 8 条整篇 replace，CI 上约 55ms）。
 */
const KEY_AT = new RegExp(String.raw`(?=${KEY}${KQ}(?:\s*(?:[:=：]|是|为)|\s+is))`, "gi");
const keyStarts = (s: string): number[] => {
  const out: number[] = [];
  KEY_AT.lastIndex = 0;
  for (let m = KEY_AT.exec(s); m; m = KEY_AT.exec(s)) {
    out.push(m.index);
    KEY_AT.lastIndex = m.index + 1;
  }
  return out;
};
const KEY_AT_Y = new RegExp(KEY_AT.source, "iy");
/** KEY_AT 匹配到的那一段（键名、引号、空白、分隔符、is）里不会有的字：占位符 [REDACTED] 的头尾。 */
const isBreak = (c: number): boolean => c === 0x5b || c === 0x5d;
/**
 * out[from] 是空白，从它往后一直是空白、在 b 之前碰到 [ 或 ]：含 out[from] 的 KEY_AT 匹配只能是在「\s* 分隔符」「\s+is」的空白里，
 * 空白后面是 [ ] 就接不上，所以不可能（块标量开头有空行时，「|\n\n  abc」换成「|\n  [REDACTED]」，差异从 \n 和空格之间开始）。
 */
function spacesToBreak(out: string, from: number, b: number): boolean {
  if (!isSpaceCode(out.charCodeAt(from))) return false;
  let q = from + 1;
  while (q < b && isSpaceCode(out.charCodeAt(q))) q++;
  return q < b && isBreak(out.charCodeAt(q));
}

/**
 * 文本 s 按 edits（按位置排好、不重叠）换成了 out，把 s 上的候选起点 starts 挪到 out 上。新的候选起点只可能和每处替换真正改了的
 * 那一段 [a, b)（去掉和原文相同的头尾）沾边：
 * - 从 b 往后起跑的，往后看到的字和原来一样：原来是候选的还是（挪个位置），原来不是的还不是；
 * - 从 a 前面起跑、又碰到 [a, b) 的，那一段要同时含 out[a-1] 和 out[a]（纯删除时是接缝两边的字）。这两个字有一个是 [ 或 ]
 *   就不可能；out[a-1] 是空白、从它往后的空白在 [a, b) 里接上 [ 的也不可能（spacesToBreak：块标量开头的空行和值一起换掉时）。裁头碰到替换文本里的 [ 就停，所以替换进去的是占位符时 out[a] 就是它的 [（原文的值也以 [R 开头时同样停在 [ 上，
 *   不会裁进占位符里面）；
 * - 起点落在 [a, b) 里的，逐个位置用 KEY_AT 试一遍（这段通常就是一个占位符，加起来不超过替换进去的字数）。
 * 多出来的旧起点留着没关系（KEY 规则在那里试不出来）。两头都不是 [ ] 的说不清，返回 null，调用方整篇重扫：只是防御，
 * 每处替换都换进一个占位符，碰不到（secrets.timing.test.ts 数着整篇扫描的次数守着）。
 */
function moveStarts(s: string, out: string, starts: readonly number[], edits: readonly Edit[]): number[] | null {
  const res: number[] = [];
  let i = 0;
  // 前面处理过的替换让后面的位置挪了多少。
  let shift = 0;
  for (const e of edits) {
    const max = Math.min(e.len, e.to.length);
    let head = 0;
    // 碰到替换文本里的 [ 就停：值本来以 [R 开头（password=[Rabc）时，不能把头裁进占位符里面（c067e822 复核必修 1）。
    while (head < max && e.to.charCodeAt(head) !== 0x5b && s.charCodeAt(e.at + head) === e.to.charCodeAt(head)) head++;
    let tail = 0;
    while (tail < max - head && s.charCodeAt(e.at + e.len - 1 - tail) === e.to.charCodeAt(e.to.length - 1 - tail)) tail++;
    const oldA = e.at + head;
    const oldB = e.at + e.len - tail;
    const a = oldA + shift;
    const b = e.at + shift + e.to.length - tail;
    if (a > 0 && !isBreak(out.charCodeAt(a - 1)) && !isBreak(out.charCodeAt(a)) && !spacesToBreak(out, a - 1, b)) return null;
    while (i < starts.length && starts[i] < oldA) res.push(starts[i++] + shift);
    while (i < starts.length && starts[i] < oldB) i++;
    for (let q = a; q < b; q++) {
      KEY_AT_Y.lastIndex = q;
      if (KEY_AT_Y.test(out)) res.push(q);
    }
    shift += e.to.length - e.len;
  }
  while (i < starts.length) res.push(starts[i++] + shift);
  return res;
}

/** 每条 KEY 规则的 sticky 副本（只在给定的位置试）。 */
const STICKY = new Map<RegExp, RegExp>();
const stickyOf = (re: RegExp): RegExp => {
  let y = STICKY.get(re);
  if (!y) {
    y = new RegExp(re.source, re.flags.replace("g", "") + "y");
    STICKY.set(re, y);
  }
  return y;
};

/** 规则的替换：和 String.prototype.replace 的回调同样的参数（match, 各捕获组…, offset, whole）。 */
const replacer =
  ({ skip, mask }: Rule) =>
  (...args: unknown[]): string => {
    const m = args[0] as string;
    // 有捕获组时第二个参数是要保留的前缀。
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
  };

/**
 * 和 s.replace(re, fn) 一样（从左往右、不重叠），但只在 starts 这些位置试：匹配只可能从这些位置开始，结果相同。
 * 一处都没换的返回原来那个串。
 */
function replaceAt(s: string, re: RegExp, starts: readonly number[], fn: (...args: unknown[]) => string): string {
  const y = stickyOf(re);
  let out = "";
  let last = 0;
  let changed = false;
  for (const p of starts) {
    if (p < last) continue;
    y.lastIndex = p;
    const m = y.exec(s);
    if (!m) continue;
    out += s.slice(last, p) + fn(...m, p, s);
    last = p + m[0].length;
    changed = true;
  }
  return changed ? out + s.slice(last) : s;
}

/** 包一层替换回调，把每处真正改了的替换记进 edits（回调的倒数第二个参数是位置：规则里都没有命名捕获组）。 */
const recording =
  (fn: (...args: unknown[]) => string, edits: Edit[]) =>
  (...args: unknown[]): string => {
    const to = fn(...args);
    const m = args[0] as string;
    if (to !== m) edits.push({ at: args[args.length - 2] as number, len: m.length, to });
    return to;
  };

/** 按顺序跑表头表格和每条规则。 */
const maskRules = (s: string): string => {
  // 表头表格整格打码：排在前面，整格先换成一个占位符，后面的规则不会把格子拆开。
  let out = maskTables(s);
  // KEY 规则的候选起点（对当前的 out）：第一条 KEY 规则前扫一次，之后哪条规则改了文本就按它的替换挪过去（见 KEY_AT）；
  // 挪不了的是 null，下一条 KEY 规则前重扫。第一次扫之前不用记替换。
  let starts: number[] | null = null;
  let tracking = false;
  for (const rule of RULES) {
    const before = out;
    const edits: Edit[] = [];
    if (rule.arg) out = maskCommands(out, rule.re, rule.arg, tracking ? edits : undefined);
    else if (rule.keyed) {
      starts ??= keyStarts(out);
      tracking = true;
      if (starts.length > 0) out = replaceAt(out, rule.re, starts, recording(replacer(rule), edits));
    } else out = out.replace(rule.re, tracking ? recording(replacer(rule), edits) : replacer(rule));
    if (tracking && starts !== null && out !== before) starts = moveStarts(before, out, starts, edits);
  }
  return out;
};

/**
 * 把能认出来的密钥换成 SECRET_MASK。
 * 有全角字母符号、零宽或框线字符的先规范化（normalize）再打码：打了码的，输出用规范化以后的文本
 * （这几行的全角字母、＝、框线会变成半角，中文标点不动；存进记忆的是规范化文本）。什么都没打的原样返回原文，一个字都不改
 * （hasSecret 不会因为一个全角字母就说有密钥）。规范化只把字换得更像 ASCII（规则都是按 ASCII 写的），原文认得出的
 * 规范化以后也认得出，所以不再按原文打一遍（再打一遍最慢的输入要翻倍，200KB 约 38ms）。没有这些字符的文本不规范化。
 */
export function maskSecrets(s: string): string {
  const normalized = normalize(s);
  if (normalized === s) return maskRules(s);
  const masked = maskRules(normalized);
  return masked === normalized ? s : masked;
}

/** 有没有能认出来的密钥（打码前后不一样）。 */
export function hasSecret(s: string): boolean {
  return maskSecrets(s) !== s;
}
