/**
 * StateCore 蒸馏用的模型（它的 DigestChatModel 注入点）。只有 PrivacyGateway.statecoreModel() 能造出来：
 * 每次 chat() 都在 gateway 里检查档位、预算，写审计，带上 key 发送（计划 4 R1）。
 */
export interface StatecoreChatModel {
  chat(messages: { role: "system" | "user"; content: string }[]): Promise<string>;
}
