// smoke-test.mjs — end-to-end verification of the lark profile without any
// Feishu app or real model:
//   1. sets up the `lark` profile under a workspace-local DSH_HOME,
//   2. boots it with a mock model route + mock Feishu transport,
//   3. drives messages through the mock transport and asserts the replies.
//
// Usage:  node test/smoke-test.mjs   (run from the repository root)

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { parseApprovalOutcome, parseBatch, parseQuestionAnswer } from "../lib/answers.js";

const REPO = resolve(process.cwd());
const DSH_HOME = join(REPO, ".dsh-test");
const RUN = join(REPO, "test", "run");
const MOCK_LLM_PORT = 4799;
const MOCK_BRIDGE_PORT = 4780;

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}
function fail(label, detail) {
  check(label, false, detail);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForPort(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePort, reject) => {
    const attempt = () => {
      if (Date.now() > deadline) return reject(new Error(`port ${port} never opened`));
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolvePort();
      });
      socket.once("error", () => {
        socket.destroy();
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

async function post(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.status;
}

async function getOutgoing(port) {
  const response = await fetch(`http://127.0.0.1:${port}/outgoing`);
  return response.json();
}

async function pollOutgoing(port, predicate, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await getOutgoing(port);
    const hit = entries.find(predicate);
    if (hit) return hit;
    await sleep(400);
  }
  throw new Error("timed out waiting for an outgoing message");
}

/** Wait for a sealed (green) streaming card whose card JSON contains text. */
async function pollSealedCard(port, needle, opts = {}) {
  const { chatId, timeoutMs = 90000 } = opts;
  return pollOutgoing(port, (e) => {
    if (e.kind !== "patch" || e.card?.header?.template !== "green") return false;
    if (!JSON.stringify(e.card).includes(needle)) return false;
    if (chatId !== undefined && e.chat_id !== chatId) return false;
    return true;
  }, timeoutMs);
}

/** Wait for the live streaming card (kind=card, streaming_mode on). */
async function pollStreamingCard(port, needle, opts = {}) {
  const { chatId, timeoutMs = 90000 } = opts;
  return pollOutgoing(port, (e) => {
    if (e.kind !== "card" || e.card?.config?.streaming_mode !== true) return false;
    if (!JSON.stringify(e.card).includes(needle)) return false;
    if (chatId !== undefined && e.chat_id !== chatId) return false;
    return true;
  }, timeoutMs);
}

function incoming(overrides) {
  return {
    sender: { sender_type: "user", sender_id: { open_id: "ou_test_user" } },
    message: {
      message_id: `om_test_${Math.random().toString(36).slice(2, 10)}`,
      chat_id: "oc_test_chat",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "你好" }),
      ...overrides
    }
  };
}

async function main() {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true });
  rmSync(join(DSH_HOME, "lark-bridge-state.json"), { force: true });

  // Clear any stale mock-llm / lark-profile processes from previous runs.
  spawnSync("pkill", ["-f", "mock-llm-server"], { stdio: "ignore" });
  spawnSync("pkill", ["-f", "profile lark"], { stdio: "ignore" });
  await sleep(800);

  // Rebuild the test profile from scratch (a stale pnpm store link would
  // otherwise trip ERR_PNPM_UNEXPECTED_STORE).
  rmSync(join(DSH_HOME, "profiles", "lark"), { recursive: true, force: true });

  // 0. Pack the plugin from the repo root and install it from the tarball.
  //    A tarball install goes through the pnpm store exactly like a
  //    `github:` or npm install, so this validates that the plugin resolves
  //    its @deepseek-ai/* dependencies in the real install layout.
  const fs = await import("node:fs");
  const pack = spawnSync("pnpm", ["pack", "--pack-destination", RUN], {
    cwd: REPO,
    env: { ...process.env },
    stdio: "inherit"
  });
  if (pack.status !== 0) {
    console.error("pnpm pack failed");
    process.exit(1);
  }
  const tgz = fs.readdirSync(RUN).find((f) => f.endsWith(".tgz"));
  if (!tgz) {
    console.error("no tarball produced by pnpm pack");
    process.exit(1);
  }
  const setup = spawnSync("dsh", ["plugin", "--profile", "lark", "add", join(RUN, tgz), "--ignore-scripts"], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME },
    stdio: "inherit"
  });
  if (setup.status !== 0) {
    console.error("profile setup failed");
    process.exit(1);
  }
  check("profile setup from packed tarball", true);

  // 1. Start the mock LLM.
  const llm = spawn(process.execPath, [join(REPO, "test", "mock-llm-server.mjs")], {
    cwd: REPO,
    env: { ...process.env, MOCK_LLM_PORT: String(MOCK_LLM_PORT) },
    stdio: "inherit"
  });
  await waitForPort(MOCK_LLM_PORT);

  // 2. Boot the lark profile with the test overlay.
  const bridge = spawn("dsh", ["--profile", "lark", "--patch", join(REPO, "test", "lark-test-overlay.yml")], {
    cwd: REPO,
    env: {
      ...process.env,
      DSH_HOME,
      LARK_APP_ID: "cli_test",
      LARK_APP_SECRET: "test-secret",
      MOCK_LLM_KEY: "test-key"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let bridgeLog = "";
  bridge.stdout.on("data", (c) => { bridgeLog += c; });
  bridge.stderr.on("data", (c) => { bridgeLog += c; });

  try {
    await waitForPort(MOCK_BRIDGE_PORT, 45000);

    // 3. Plain user message → streaming card + ack + final answer.
    const msg1 = incoming({ message_id: "om_test_1", content: JSON.stringify({ text: "你好，请回复一句话" }) });
    await post(MOCK_BRIDGE_PORT, "/incoming", msg1);
    const ack = await pollOutgoing(MOCK_BRIDGE_PORT, (e) => e.kind === "reply" && e.message_id === "om_test_1" && e.text.includes("⏳"));
    check("ack reply sent", Boolean(ack), ack ? ack.text.slice(0, 30) : "");
    const streamCard = await pollStreamingCard(MOCK_BRIDGE_PORT, "DSH 处理中", { chatId: "oc_test_chat" });
    check("streaming card created", Boolean(streamCard) && streamCard.card?.config?.streaming_mode === true, JSON.stringify(streamCard?.card?.header));
    const sealed = await pollSealedCard(MOCK_BRIDGE_PORT, "MOCK-REPLY", { chatId: "oc_test_chat" });
    check("final answer in sealed card", Boolean(sealed) && sealed.card?.header?.template === "green", JSON.stringify(sealed?.card?.header));
    check("sealed card shows streaming-mode off", sealed.card?.config?.streaming_mode !== true, "");

    // 4. /help (no model call needed).
    const help = incoming({ message_id: "om_test_2", content: JSON.stringify({ text: "/help" }) });
    await post(MOCK_BRIDGE_PORT, "/incoming", help);
    const helpReply = await pollOutgoing(MOCK_BRIDGE_PORT, (e) => e.kind === "reply" && e.message_id === "om_test_2");
    check("/help lists commands", helpReply.text.includes("/new") && helpReply.text.includes("/status"));

    // 5. /status shows session + model.
    const status = incoming({ message_id: "om_test_3", content: JSON.stringify({ text: "/status" }) });
    await post(MOCK_BRIDGE_PORT, "/incoming", status);
    const statusReply = await pollOutgoing(MOCK_BRIDGE_PORT, (e) => e.kind === "reply" && e.message_id === "om_test_3");
    check("/status shows model", statusReply.text.includes("mock/mock-model"), statusReply.text.replace(/\n/g, " ").slice(0, 80));

    // 6. Group chat: message WITHOUT a bot mention must be ignored.
    const before = (await getOutgoing(MOCK_BRIDGE_PORT)).length;
    const groupNoMention = incoming({
      message_id: "om_test_4",
      chat_id: "oc_test_group",
      chat_type: "group",
      content: JSON.stringify({ text: "普通群消息" })
    });
    await post(MOCK_BRIDGE_PORT, "/incoming", groupNoMention);
    await sleep(2500);
    const after = (await getOutgoing(MOCK_BRIDGE_PORT)).length;
    check("group message without mention ignored", after === before);

    // 7. Group chat: message WITH a bot mention (mentioned_type app) is handled.
    const groupMention = incoming({
      message_id: "om_test_5",
      chat_id: "oc_test_group",
      chat_type: "group",
      content: JSON.stringify({ text: "@_user_1 帮我看看" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_test_bot" }, mentioned_type: "app", name: "DSH 助手" }]
    });
    await post(MOCK_BRIDGE_PORT, "/incoming", groupMention);
    const groupSealed = await pollSealedCard(MOCK_BRIDGE_PORT, "MOCK-REPLY", { chatId: "oc_test_group" });
    check("group message with bot mention handled", Boolean(groupSealed));

    // 8. Second user message continues the SAME session (resume path).
    const status2 = incoming({ message_id: "om_test_6", content: JSON.stringify({ text: "/status" }) });
    await post(MOCK_BRIDGE_PORT, "/incoming", status2);
    const statusReply2 = await pollOutgoing(MOCK_BRIDGE_PORT, (e) => e.kind === "reply" && e.message_id === "om_test_6");
    const session1 = statusReply.text.match(/会话: (\S+)/)?.[1];
    const session2 = statusReply2.text.match(/会话: (\S+)/)?.[1];
    check("session resumes across messages", session1 !== undefined && session1 === session2, `${session1} -> ${session2}`);

    // 9. State file persisted (checked before /new, which clears the mapping).
    const state = JSON.parse(fs.readFileSync(join(DSH_HOME, "lark-bridge-state.json"), "utf8"));
    check("state file persisted", state.chats?.["oc_test_chat"] === session1, String(state.chats?.["oc_test_chat"]));

    // 10. /new starts a fresh session: the next real message lands in a NEW session.
    const fresh = incoming({ message_id: "om_test_7", content: JSON.stringify({ text: "/new" }) });
    await post(MOCK_BRIDGE_PORT, "/incoming", fresh);
    await pollOutgoing(MOCK_BRIDGE_PORT, (e) => e.kind === "reply" && e.message_id === "om_test_7");
    const afterNew = incoming({ message_id: "om_test_8", content: JSON.stringify({ text: "新会话的第一条消息" }) });
    await post(MOCK_BRIDGE_PORT, "/incoming", afterNew);
    await pollSealedCard(MOCK_BRIDGE_PORT, "MOCK-REPLY", { chatId: "oc_test_chat" });
    const status3 = incoming({ message_id: "om_test_9", content: JSON.stringify({ text: "/status" }) });
    await post(MOCK_BRIDGE_PORT, "/incoming", status3);
    const statusReply3 = await pollOutgoing(MOCK_BRIDGE_PORT, (e) => e.kind === "reply" && e.message_id === "om_test_9");
    const session3 = statusReply3.text.match(/会话: (\S+)/)?.[1];
    check("/new starts a new session", session1 !== undefined && session3 !== undefined && session1 !== session3, `${session1} -> ${session3}`);

    // 11. Image upload: saved to the uploads dir AND attached (mock model is image-capable).
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const imgMsg = incoming({
      message_id: "om_test_10",
      message_type: "image",
      content: JSON.stringify({ image_key: "img_v2_mock" }),
      mockResource: { fileName: "pixel.png", mediaType: "image/png", base64: pngBase64 }
    });
    await post(MOCK_BRIDGE_PORT, "/incoming", imgMsg);
    const imgSealed = await pollSealedCard(MOCK_BRIDGE_PORT, "收到图片", { chatId: "oc_test_chat" });
    check("image upload processed with saved path", Boolean(imgSealed) && JSON.stringify(imgSealed.card).includes(".lark-uploads"), JSON.stringify(imgSealed?.card).replace(/\n/g, " ").slice(0, 120));
    const uploadsDir = join(RUN, ".lark-uploads");
    const uploads = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
    check("image bytes saved to uploads dir", uploads.some((f) => f.endsWith(".png")), uploads.join(", "));
    const attachmentsRoot = join(DSH_HOME, "attachments", "v1", "objects");
    const objects = fs.existsSync(attachmentsRoot) ? fs.readdirSync(attachmentsRoot) : [];
    check("image attached through attachments store", objects.length > 0, `objects dirs: ${objects.join(", ")}`);

    // 12. File upload: saved + absolute path included for the agent.
    const fileMsg = incoming({
      message_id: "om_test_11",
      message_type: "file",
      content: JSON.stringify({ file_key: "file_v4_mock", file_name: "notes.txt", file_size: 15 }),
      mockResource: { fileName: "notes.txt", text: "hello lark file" }
    });
    await post(MOCK_BRIDGE_PORT, "/incoming", fileMsg);
    const fileSealed = await pollSealedCard(MOCK_BRIDGE_PORT, "收到文件", { chatId: "oc_test_chat" });
    check("file upload processed with saved path", Boolean(fileSealed) && JSON.stringify(fileSealed.card).includes("notes.txt"), JSON.stringify(fileSealed?.card).replace(/\n/g, " ").slice(0, 120));

    // 13. Post (rich text) message: reduced to plain text and processed.
    const postMsg = incoming({
      message_id: "om_test_12",
      message_type: "post",
      content: JSON.stringify({ title: "标题A", content: [[{ tag: "text", text: "富文本内容B" }]] })
    });
    await post(MOCK_BRIDGE_PORT, "/incoming", postMsg);
    const postSealed = await pollSealedCard(MOCK_BRIDGE_PORT, "标题A", { chatId: "oc_test_chat" });
    check("post message reduced to text", Boolean(postSealed) && JSON.stringify(postSealed.card).includes("富文本内容B"), JSON.stringify(postSealed?.card).replace(/\n/g, " ").slice(0, 120));

    // 14. Answer-parsing unit checks (v3.0).
    const qOpt = { id: "a", question: "选哪个？", options: [{ label: "甲" }, { label: "乙" }] };
    const u1 = parseQuestionAnswer(qOpt, "1");
    check("answer: option by number", u1.selected.length === 1 && u1.selected[0] === "甲", JSON.stringify(u1));
    const u2 = parseQuestionAnswer(qOpt, "乙");
    check("answer: option by label", u2.selected[0] === "乙", JSON.stringify(u2));
    const u3 = parseQuestionAnswer(qOpt, "自定义内容");
    check("answer: custom overrides", u3.custom === "自定义内容" && u3.selected.length === 0, JSON.stringify(u3));
    const u4 = parseQuestionAnswer({ id: "b", question: "多选？", options: [{ label: "x" }, { label: "y" }], multiSelect: true }, "1,2");
    check("answer: multi-select", u4.selected.length === 2, JSON.stringify(u4));
    const batch = parseBatch("1. 甲\n2. 都不要", [qOpt, { id: "c", question: "第二题", options: [{ label: "甲" }, { label: "乙" }] }]);
    check("answer: batch by index", batch[0].selected[0] === "甲" && batch[1].custom === "都不要", JSON.stringify(batch));
    const slashBatch = parseBatch("2/1", [qOpt, { id: "c", question: "第二题", options: [{ label: "甲" }, { label: "乙" }] }]);
    check("answer: batch by slash positions", slashBatch[0].selected[0] === "乙" && slashBatch[1].selected[0] === "甲", JSON.stringify(slashBatch));
    check("approval: allow words", parseApprovalOutcome("批准") === "allowed-once" && parseApprovalOutcome("1") === "allowed-once" && parseApprovalOutcome("yes") === "allowed-once");
    check("approval: reject words", parseApprovalOutcome("拒绝") === "rejected" && parseApprovalOutcome("2") === "rejected" && parseApprovalOutcome("随便") === "rejected");

    // 15. Interactive question flow (v3.1): agent calls ask_user_question →
    //     an interactive CARD with option buttons is sent → clicking a button
    //     (card.action.trigger) resumes the turn.
    const askMsg = incoming({ message_id: "om_test_13", content: JSON.stringify({ text: "ASK_QUESTION 帮我选个方案" }) });
    await post(MOCK_BRIDGE_PORT, "/incoming", askMsg);
    const card = await pollOutgoing(MOCK_BRIDGE_PORT, (e) => e.kind === "card" && JSON.stringify(e.card).includes("你想选哪个方案"));
    check("question card sent with buttons", Boolean(card) && JSON.stringify(card.card).includes("方案A") && JSON.stringify(card.card).includes('"tag":"button"'), JSON.stringify(card?.card).slice(0, 140));
    // Extract the first button's value and simulate a click.
    const firstButton = card.card.elements.find((el) => el.tag === "action").actions[0];
    const click = await post(MOCK_BRIDGE_PORT, "/incoming", { kind: "card_action", chat_id: "oc_test_chat", message_id: card.message_id, value: firstButton.value });
    const patched = await pollOutgoing(MOCK_BRIDGE_PORT, (e) => e.kind === "patch" && e.message_id === card.message_id);
    check("card patched to answered state", Boolean(patched) && JSON.stringify(patched.card).includes("已收到你的选择"), JSON.stringify(patched?.card).slice(0, 100));
    const afterClick = await pollSealedCard(MOCK_BRIDGE_PORT, "MOCK-REPLY", { chatId: "oc_test_chat" });
    check("turn resumed after card click", Boolean(afterClick), JSON.stringify(afterClick?.card).replace(/\n/g, " ").slice(0, 80));

    // 16. Multi-select question falls back to a TEXT prompt (not a card).
    //     Uses a fresh chat so the mock's ask trigger fires (no tool history).
    const multiMsg = incoming({ message_id: "om_test_15", chat_id: "oc_test_multi", content: JSON.stringify({ text: "ASK_QUESTION2 帮我选多项" }) });
    await post(MOCK_BRIDGE_PORT, "/incoming", multiMsg);
    const textQuestion = await pollOutgoing(MOCK_BRIDGE_PORT, (e) => e.kind === "create" && e.text.includes("选哪些项"));
    check("multi-select falls back to text prompt", Boolean(textQuestion), textQuestion.text.replace(/\n/g, " ").slice(0, 90));
    const multiAnswer = incoming({ message_id: "om_test_16", chat_id: "oc_test_multi", content: JSON.stringify({ text: "1,2" }) });
    await post(MOCK_BRIDGE_PORT, "/incoming", multiAnswer);
    const multiAck = await pollOutgoing(MOCK_BRIDGE_PORT, (e) => e.kind === "reply" && e.message_id === "om_test_16" && e.text.includes("已收到回答"));
    check("multi-select text answer ack", Boolean(multiAck));
    const afterMulti = await pollSealedCard(MOCK_BRIDGE_PORT, "MOCK-REPLY", { chatId: "oc_test_multi" });
    check("multi-select turn resumed", Boolean(afterMulti));

    // 17. feishu_send proactive push (v3.2): the mock model calls feishu_send
    //     when the user text contains "PUSH_IT"; the push lands in the chat.
    const pushMsg = incoming({ message_id: "om_test_17", chat_id: "oc_test_push", content: JSON.stringify({ text: "PUSH_IT 主动推送" }) });
    await post(MOCK_BRIDGE_PORT, "/incoming", pushMsg);
    const push = await pollOutgoing(MOCK_BRIDGE_PORT, (e) => e.kind === "create" && e.chat_id === "oc_test_push" && e.text.includes("主动推送成功"));
    check("feishu_send pushed to chat", Boolean(push), push ? push.text.slice(0, 60) : "");
    const pushSealed = await pollSealedCard(MOCK_BRIDGE_PORT, "已推送", { chatId: "oc_test_push" });
    check("feishu_send result in sealed card", Boolean(pushSealed), JSON.stringify(pushSealed?.card).replace(/\n/g, " ").slice(0, 80));

    console.log("\n--- bridge log (tail) ---");
    console.log(bridgeLog.split("\n").slice(-25).join("\n"));
  } catch (error) {
    fail("smoke run", String(error));
    console.log("\n--- bridge log (tail) ---");
    console.log(bridgeLog.split("\n").slice(-40).join("\n"));
  } finally {
    bridge.kill("SIGTERM");
    llm.kill("SIGTERM");
    await sleep(500);
    if (bridge.exitCode === null) bridge.kill("SIGKILL");
    if (llm.exitCode === null) llm.kill("SIGKILL");
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
