// =====================================================================
//  script.js  -  The chat logic. You shouldn't need to edit this file.
//  All the bot's personality comes from config.js.
// =====================================================================

const KEY_STORAGE_NAME = "gemini_api_key";

const chatEl = document.getElementById("chat");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");
const keyModal = document.getElementById("keyModal");
const keyInput = document.getElementById("keyInput");
const rememberBox = document.getElementById("rememberBox");
const keyStatus = document.getElementById("keyStatus");

let history = [];   // the conversation sent to Gemini
let busy = false;   // true while waiting for a reply

/* ---------------- API key storage (safe if storage is blocked) ---------------- */

function getKey() {
  try {
    const k = sessionStorage.getItem(KEY_STORAGE_NAME);
    if (k) return k;
  } catch (e) {}
  try {
    const k = localStorage.getItem(KEY_STORAGE_NAME);
    if (k) return k;
  } catch (e) {}
  return "";
}

function clearKey() {
  try { sessionStorage.removeItem(KEY_STORAGE_NAME); } catch (e) {}
  try { localStorage.removeItem(KEY_STORAGE_NAME); } catch (e) {}
}

function saveKey(key, remember) {
  clearKey();
  try { sessionStorage.setItem(KEY_STORAGE_NAME, key); } catch (e) {}
  if (remember) {
    try { localStorage.setItem(KEY_STORAGE_NAME, key); } catch (e) {}
  }
}

function isKeyRemembered() {
  try { return !!localStorage.getItem(KEY_STORAGE_NAME); } catch (e) { return false; }
}

/* ---------------- Pop-up ---------------- */

function openKeyModal() {
  keyInput.value = getKey();
  rememberBox.checked = isKeyRemembered();
  keyStatus.textContent = getKey() ? "A key is currently saved." : "No key saved yet.";
  keyModal.hidden = false;
  keyInput.focus();
}

function closeKeyModal() {
  keyModal.hidden = true;
}

document.getElementById("keyBtn").addEventListener("click", openKeyModal);
document.getElementById("keyCancel").addEventListener("click", closeKeyModal);
document.getElementById("keySave").addEventListener("click", () => {
  const key = keyInput.value.trim();
  if (!key) {
    keyStatus.textContent = "Please paste a key first.";
    return;
  }
  saveKey(key, rememberBox.checked);
  closeKeyModal();
  inputEl.focus();
});
document.getElementById("keyClear").addEventListener("click", () => {
  clearKey();
  keyInput.value = "";
  rememberBox.checked = false;
  keyStatus.textContent = "Key removed.";
});
keyModal.addEventListener("click", (e) => { if (e.target === keyModal) closeKeyModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !keyModal.hidden) closeKeyModal(); });
keyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("keySave").click(); });

/* ---------------- Safe text formatting ---------------- */
// Step 1: escape HTML so nothing sneaky can run. Step 2: add bold and lists.

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineFormat(s) {
  return s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function formatText(raw) {
  const lines = escapeHtml(raw).split("\n");
  let html = "";
  let para = [];
  let listType = null;

  const flushPara = () => {
    if (para.length) { html += "<p>" + para.join("<br>") + "</p>"; para = []; }
  };
  const closeList = () => {
    if (listType) { html += "</" + listType + ">"; listType = null; }
  };

  for (const line of lines) {
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const number = line.match(/^\s*(\d+)[.)]\s+(.*)$/);

    if (bullet || number) {
      flushPara();
      const type = bullet ? "ul" : "ol";
      if (listType !== type) {
        closeList();
        html += type === "ol" ? '<ol start="' + number[1] + '">' : "<ul>";
        listType = type;
      }
      html += "<li>" + inlineFormat(bullet ? bullet[1] : number[2]) + "</li>";
    } else if (line.trim() === "") {
      flushPara();
    } else {
      closeList();
      para.push(inlineFormat(line));
    }
  }
  flushPara();
  closeList();
  return html;
}

/* ---------------- Drawing messages ---------------- */

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function addMessage(kind, text) {
  const div = document.createElement("div");
  div.className = "msg " + kind;
  if (kind === "bot") div.innerHTML = formatText(text);
  else div.textContent = text; // user + error text: plain text, always safe
  chatEl.appendChild(div);
  scrollToBottom();
  return div;
}

function showThinking() {
  const div = document.createElement("div");
  div.className = "msg bot thinking";
  div.id = "thinking";
  div.setAttribute("aria-label", "Thinking");
  div.innerHTML = "<span></span><span></span><span></span>";
  chatEl.appendChild(div);
  scrollToBottom();
}

function hideThinking() {
  const t = document.getElementById("thinking");
  if (t) t.remove();
}

function removeStarters() {
  const s = document.getElementById("starters");
  if (s) s.remove();
}

function showWelcome() {
  addMessage("bot", CONFIG.welcomeMessage);
  const box = document.createElement("div");
  box.className = "starters";
  box.id = "starters";
  CONFIG.starterQuestions.forEach((q) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "starter";
    b.textContent = q;
    b.addEventListener("click", () => sendMessage(q));
    box.appendChild(b);
  });
  chatEl.appendChild(box);
}

/* ---------------- Talking to Gemini ---------------- */

function friendlyHttpError(status) {
  if (status === 400 || status === 403) {
    return "Gemini didn't accept your API key. Click “🔑 API key” and check that you pasted it correctly.";
  }
  if (status === 404) {
    return "Gemini couldn't find that model. Open config.js and check the model name.";
  }
  if (status === 429) {
    return "You're sending messages too fast, or you've hit the free limit. Please wait a minute and try again.";
  }
  if (status >= 500) {
    return "Gemini's servers are having trouble right now. Please try again in a moment.";
  }
  return "Something went wrong (error " + status + "). Please try again.";
}

async function askGemini() {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(CONFIG.model) +
    ":generateContent";

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": getKey(),
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: CONFIG.systemInstructions }] },
        contents: history,
      }),
    });
  } catch (e) {
    throw new Error("I can't reach the internet. Please check your connection and try again.");
  }

  if (!response.ok) throw new Error(friendlyHttpError(response.status));

  const data = await response.json();
  const parts =
    (data && data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts) || [];

  // Join the text parts, skipping any "thought" parts
  const text = parts
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");

  if (!text.trim()) {
    throw new Error("Gemini didn't return an answer for that. Try rephrasing your message.");
  }
  return text;
}

async function sendMessage(text) {
  text = (text || "").trim();
  if (!text || busy) return;

  if (!getKey()) {
    inputEl.value = text;
    openKeyModal();
    return;
  }

  busy = true;
  sendBtn.disabled = true;
  removeStarters();
  addMessage("user", text);
  inputEl.value = "";
  resizeInput();
  history.push({ role: "user", parts: [{ text: text }] });
  showThinking();

  try {
    const reply = await askGemini();
    hideThinking();
    history.push({ role: "model", parts: [{ text: reply }] });
    addMessage("bot", reply);
  } catch (err) {
    hideThinking();
    history.pop(); // forget the failed message so you can simply resend it
    inputEl.value = text;
    resizeInput();
    addMessage("error", err.message || "Something unexpected went wrong. Please try again.");
  }

  busy = false;
  sendBtn.disabled = false;
  inputEl.focus();
}

/* ---------------- Input box behavior ---------------- */

function resizeInput() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px";
}

inputEl.addEventListener("input", resizeInput);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage(inputEl.value);
  }
});
sendBtn.addEventListener("click", () => sendMessage(inputEl.value));

/* ---------------- New chat ---------------- */

function newChat() {
  history = [];
  busy = false;
  sendBtn.disabled = false;
  chatEl.innerHTML = "";
  showWelcome();
}
document.getElementById("newChatBtn").addEventListener("click", newChat);

/* ---------------- Start up: apply config.js ---------------- */

document.title = CONFIG.name + " " + CONFIG.emoji;
document.getElementById("botName").textContent = CONFIG.name;
document.getElementById("botEmoji").textContent = CONFIG.emoji;
document.getElementById("botTagline").textContent = CONFIG.tagline;
document.documentElement.style.setProperty("--brand", CONFIG.themeColor);
showWelcome();
