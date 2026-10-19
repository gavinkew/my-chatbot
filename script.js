// =====================================================================
//  script.js  -  The chat logic. You shouldn't need to edit this file.
//  All the bot's personality and settings come from config.js.
// =====================================================================

const KEY_STORAGE_NAME = "gemini_api_key";
const VECTOR_STORAGE_NAME = "knowledge_vectors";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const NOTE_PART_LIMIT = 1500; // longer notes are split at blank lines

const chatEl = document.getElementById("chat");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");
const keyModal = document.getElementById("keyModal");
const keyInput = document.getElementById("keyInput");
const rememberBox = document.getElementById("rememberBox");
const keyStatus = document.getElementById("keyStatus");
const kbStatusEl = document.getElementById("kbStatus");

let history = [];   // the conversation sent to Gemini (plain questions only)
let busy = false;   // true while waiting for a reply

// Notes (knowledge) state
let notes = [];            // [{ title, text }]
let notesLoaded = false;   // true once we have tried to read the file
let notesError = "";       // "", "missing" or "empty"
let notesFingerprint = ""; // changes whenever knowledge.md changes
let vectors = null;        // one list of numbers per note
let embedOK = false;       // true when meaning search is ready
let embedFailed = "";      // the reason meaning search failed (if it did)
let kbPromise = Promise.resolve(); // lets messages wait for notes to finish loading

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
  // A new key gets a fresh try at meaning search
  embedFailed = "";
  kbPromise = kbPromise.then(startKnowledge);
  inputEl.focus();
});
document.getElementById("keyClear").addEventListener("click", () => {
  clearKey();
  keyInput.value = "";
  rememberBox.checked = false;
  keyStatus.textContent = "Key removed.";
  embedOK = false;
  vectors = null;
  embedFailed = "";
  updateStatus();
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

function makeCopyButton(text) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy-btn";
  btn.textContent = "📋 Copy";

  btn.addEventListener("click", async () => {
    const plain = text.replace(/\*\*/g, ""); // remove the ** bold marks
    let ok = false;
    try {
      await navigator.clipboard.writeText(plain);
      ok = true;
    } catch (e) {
      // Backup method for older browsers
      try {
        const box = document.createElement("textarea");
        box.value = plain;
        document.body.appendChild(box);
        box.select();
        ok = document.execCommand("copy");
        box.remove();
      } catch (e2) {}
    }
    btn.textContent = ok ? "✅ Copied!" : "⚠️ Copy failed";
    setTimeout(() => { btn.textContent = "📋 Copy"; }, 1500);
  });

  return btn;
}

// The small "Sources" section that opens under a reply
function makeSources(found) {
  const details = document.createElement("details");
  details.className = "sources";

  const summary = document.createElement("summary");
  summary.textContent = "Sources (" + found.length + ")";
  details.appendChild(summary);

  const list = document.createElement("ul");
  found.forEach((n, i) => {
    const li = document.createElement("li");

    const title = document.createElement("span");
    title.className = "source-title";
    title.textContent = "[" + (i + 1) + "] " + n.title;

    const score = document.createElement("span");
    score.className = "source-score";
    score.textContent = "  ·  score " + n.score.toFixed(2);

    const snippet = document.createElement("p");
    snippet.className = "source-snippet";
    const flat = n.text.replace(/\s+/g, " ").trim();
    snippet.textContent = flat.length > 160 ? flat.slice(0, 160) + "…" : flat;

    li.appendChild(title);
    li.appendChild(score);
    li.appendChild(snippet);
    list.appendChild(li);
  });
  details.appendChild(list);
  return details;
}

function addMessage(kind, text, withCopy, sources) {
  const div = document.createElement("div");
  div.className = "msg " + kind;
  if (kind === "bot") div.innerHTML = formatText(text);
  else div.textContent = text; // user + error text: plain text, always safe
  if (withCopy) div.appendChild(makeCopyButton(text));
  if (sources && sources.length) div.appendChild(makeSources(sources));
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

/* ---------------- Reading knowledge.md ---------------- */

// Splits one long note into parts at blank lines
function splitLong(body) {
  if (body.length <= NOTE_PART_LIMIT) return [body];
  const paragraphs = body.split(/\n\s*\n/);
  const parts = [];
  let current = "";
  for (const p of paragraphs) {
    if (current && current.length + p.length + 2 > NOTE_PART_LIMIT) {
      parts.push(current);
      current = p;
    } else {
      current = current ? current + "\n\n" + p : p;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// Each note starts with a line like "## Note title".
// Anything above the first "##" line is ignored.
function parseKnowledge(md) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const raw = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      current = { title: m[1], lines: [] };
      raw.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  const result = [];
  for (const n of raw) {
    const body = n.lines.join("\n").trim();
    if (!body) continue;
    const parts = splitLong(body);
    parts.forEach((p, i) => {
      result.push({
        title: parts.length > 1 ? n.title + " (part " + (i + 1) + ")" : n.title,
        text: p,
      });
    });
  }
  return result;
}

// A short "fingerprint" of the file, so we notice when it changes
function fingerprint(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16) + "-" + str.length;
}

async function loadNotesFile() {
  notesLoaded = true;
  notes = [];
  notesError = "";
  try {
    const res = await fetch(CONFIG.knowledgeFile, { cache: "no-cache" });
    if (!res.ok) { notesError = "missing"; return; }
    const md = await res.text();
    notesFingerprint = fingerprint(CONFIG.embeddingModel + "\n" + md);
    notes = parseKnowledge(md);
    if (!notes.length) notesError = "empty";
  } catch (e) {
    notesError = "missing";
  }
}

/* ---------------- Embeddings (meaning search) ---------------- */

function embedReason(status) {
  if (status === 400 || status === 403) return "API key not accepted";
  if (status === 404) return "embedding model not found, check embeddingModel in config.js";
  if (status === 429) return "rate limit reached";
  if (status >= 500) return "Gemini server problem";
  return "error " + status;
}

// Turns a list of texts into a list of number-lists (vectors)
async function batchEmbed(texts) {
  const model = CONFIG.embeddingModel;
  const url = API_BASE + encodeURIComponent(model) + ":batchEmbedContents";
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": getKey(),
      },
      body: JSON.stringify({
        requests: texts.map((t) => ({
          model: "models/" + model,
          content: { parts: [{ text: t }] },
        })),
      }),
    });
  } catch (e) {
    throw new Error("no internet connection");
  }
  if (!res.ok) throw new Error(embedReason(res.status));

  const data = await res.json();
  const list = data && data.embeddings;
  if (!Array.isArray(list) || list.length !== texts.length || list.some((e) => !e || !e.values)) {
    throw new Error("unexpected reply from the embedding model");
  }
  return list.map((e) => e.values);
}

function readVectorCache() {
  try {
    const saved = JSON.parse(localStorage.getItem(VECTOR_STORAGE_NAME) || "null");
    if (saved && saved.fingerprint === notesFingerprint &&
        Array.isArray(saved.vectors) && saved.vectors.length === notes.length) {
      return saved.vectors;
    }
  } catch (e) {}
  return null;
}

function writeVectorCache(list) {
  try {
    // Rounding keeps the saved data small enough for the browser
    const small = list.map((v) => v.map((x) => Math.round(x * 10000) / 10000));
    localStorage.setItem(
      VECTOR_STORAGE_NAME,
      JSON.stringify({ fingerprint: notesFingerprint, vectors: small })
    );
  } catch (e) {}
}

async function embedNotes() {
  const cached = readVectorCache();
  if (cached) {
    vectors = cached;
    embedOK = true;
    return;
  }
  try {
    const texts = notes.map((n) => "title: " + n.title + " | text: " + n.text);
    const all = [];
    for (let i = 0; i < texts.length; i += 50) {
      const batch = await batchEmbed(texts.slice(i, i + 50));
      all.push(...batch);
    }
    vectors = all;
    embedOK = true;
    writeVectorCache(all);
  } catch (e) {
    vectors = null;
    embedOK = false;
    embedFailed = e.message || "unknown problem";
  }
}

async function embedQuery(question) {
  const result = await batchEmbed(["task: search result | query: " + question]);
  return result[0];
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/* ---------------- Keyword search (simple backup) ---------------- */

const STOP_WORDS = new Set((
  "a an and are as at be by can do does for from how i if in is it me my of on or so that the " +
  "this to was we what when where which who why will with you your test tests review help please " +
  "about give tell explain could would should"
).split(" "));

function tokenize(s) {
  const words = s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return words
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
}

function keywordSearch(question, k) {
  const terms = Array.from(new Set(tokenize(question)));
  if (!terms.length) return [];
  const scored = notes.map((n) => {
    const titleWords = new Set(tokenize(n.title));
    const bodyWords = new Set(tokenize(n.text));
    let points = 0;
    for (const t of terms) {
      if (titleWords.has(t)) points += 2;
      if (bodyWords.has(t)) points += 1;
    }
    return { title: n.title, text: n.text, score: points / (3 * terms.length) };
  });
  return scored.filter((n) => n.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

/* ---------------- Choosing notes for a question ---------------- */

async function retrieve(question) {
  if (!CONFIG.useKnowledge || !notes.length) return [];
  const k = Math.max(1, Number(CONFIG.topK) || 3);

  if (CONFIG.searchMethod === "meaning" && embedOK && vectors) {
    try {
      const q = await embedQuery(question);
      return notes
        .map((n, i) => ({ title: n.title, text: n.text, score: cosine(q, vectors[i]) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    } catch (e) {
      // Meaning search failed: switch to keyword search automatically
      embedOK = false;
      embedFailed = e.message || "unknown problem";
      updateStatus();
    }
  }
  return keywordSearch(question, k);
}

function buildPrompt(question, found) {
  if (!found.length) {
    return "NOTES:\n(No matching notes were found.)\n\nQUESTION:\n" + question;
  }
  const blocks = found.map((n, i) => "[" + (i + 1) + "] " + n.title + "\n" + n.text);
  return "NOTES:\n" + blocks.join("\n\n") + "\n\nQUESTION:\n" + question;
}

/* ---------------- Status line under the header ---------------- */

function setStatus(text, kind) {
  kbStatusEl.hidden = false;
  kbStatusEl.textContent = text;
  kbStatusEl.className = "kb-status" + (kind === "warn" ? " warn" : "");
}

function updateStatus() {
  if (!CONFIG.useKnowledge) { kbStatusEl.hidden = true; return; }
  if (notesError === "missing") {
    setStatus("📚 I can't find " + CONFIG.knowledgeFile + ". Add it to your repository, in the same folder as index.html.", "warn");
    return;
  }
  if (notesError === "empty") {
    setStatus("📚 " + CONFIG.knowledgeFile + " has no notes yet. Start each note with a line like: ## My note title", "warn");
    return;
  }
  if (!notesLoaded) { setStatus("📚 Loading notes…"); return; }

  const count = notes.length + (notes.length === 1 ? " note" : " notes");
  if (CONFIG.searchMethod !== "meaning") {
    setStatus("📚 " + count + " loaded · keyword search");
  } else if (embedOK) {
    setStatus("📚 " + count + " loaded · meaning search");
  } else if (embedFailed) {
    setStatus("📚 " + count + " loaded · keyword search (meaning search unavailable: " + embedFailed + ")", "warn");
  } else if (!getKey()) {
    setStatus("📚 " + count + " loaded · keyword search for now (add your API key to turn on meaning search)");
  } else {
    setStatus("📚 " + count + " loaded · preparing meaning search…");
  }
}

async function startKnowledge() {
  if (!CONFIG.useKnowledge) { updateStatus(); return; }
  try {
    if (!notesLoaded || !notes.length) {
      updateStatus();
      await loadNotesFile();
    }
    updateStatus();
    if (notes.length && CONFIG.searchMethod === "meaning" && getKey() && !embedOK && !embedFailed) {
      await embedNotes();
    }
  } catch (e) {}
  updateStatus();
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

// promptText = what the newest question looks like when sent (may include notes).
// The saved history keeps only the plain questions.
async function askGemini(promptText, useNotes) {
  const url = API_BASE + encodeURIComponent(CONFIG.model) + ":generateContent";

  let system = CONFIG.systemInstructions;
  if (useNotes) system += "\n\n" + CONFIG.knowledgeRules;

  const contents = history.map((m, i) =>
    i === history.length - 1 && m.role === "user"
      ? { role: "user", parts: [{ text: promptText }] }
      : m
  );

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": getKey(),
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: contents,
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
    // Wait for the notes to finish loading, then pick the best ones
    try { await kbPromise; } catch (e) {}
    const useNotes = CONFIG.useKnowledge && notes.length > 0;
    let found = [];
    let prompt = text;
    if (useNotes) {
      found = await retrieve(text);
      prompt = buildPrompt(text, found);
    }

    const reply = await askGemini(prompt, useNotes);
    hideThinking();
    history.push({ role: "model", parts: [{ text: reply }] });
    addMessage("bot", reply, true, found);
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
updateStatus();
kbPromise = kbPromise.then(startKnowledge);
