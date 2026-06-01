// =====================================================
// LuaFixBot — Discord bot untuk memperbaiki script Lua
// Powered by Groq AI (Gratis) + Pastefy.app
// =====================================================
// SETUP:
// 1. npm install discord.js dotenv
// 2. Buat file .env:
//    DISCORD_TOKEN=token_bot_kamu
//    GROQ_API_KEY=api_key_groq_kamu
//    CLIENT_ID=client_id_bot_kamu
//    PASTEFY_API_KEY=api_key_pastefy_kamu  (opsional)
// 3. node index.js
// =====================================================

require("dotenv").config();
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, codeBlock,
} = require("discord.js");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// ─── Pastefy Helpers ─────────────────────────────────

// Ambil ID paste dari URL pastefy
function parsePastefyId(input) {
  input = input.trim();
  // Hapus trailing slash, /raw, /download, dsb
  // Format: https://pastefy.app/XXXX atau pastefy.app/XXXX/raw dll
  const urlMatch = input.match(/pastefy\.app\/([A-Za-z0-9_-]+)/i);
  if (urlMatch) return urlMatch[1];
  // Kalau langsung ID saja (misal: 3JHyDSEo)
  if (/^[A-Za-z0-9_-]{4,20}$/.test(input)) return input;
  return null;
}

// Ambil konten paste dari Pastefy API
async function fetchPaste(pasteId) {
  const headers = { "Accept": "application/json" };
  if (process.env.PASTEFY_API_KEY) {
    headers["Authorization"] = `Bearer ${process.env.PASTEFY_API_KEY}`;
  }
  const res = await fetch(`https://pastefy.app/api/v2/paste/${pasteId}`, { headers });
  if (!res.ok) throw new Error(`Paste tidak ditemukan atau private (HTTP ${res.status})`);
  const data = await res.json();
  // API Pastefy v2: { paste: { id, content, title, ... } }
  const paste = data.paste || data;
  if (!paste || !paste.content) throw new Error("Paste tidak memiliki konten");
  return paste;
}

// Upload hasil fix ke Pastefy, return URL
async function uploadToPastefy(title, content) {
  const headers = { "Content-Type": "application/json" };
  if (process.env.PASTEFY_API_KEY) {
    headers["Authorization"] = `Bearer ${process.env.PASTEFY_API_KEY}`;
  }
  const res = await fetch("https://pastefy.app/api/v2/paste", {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: title || "Lua Fixed by LuaFixBot",
      content,
      type: "PASTE",
      visibility: "UNLISTED",
    }),
  });
  if (!res.ok) throw new Error(`Gagal upload ke Pastefy (HTTP ${res.status})`);
  const data = await res.json();
  return `https://pastefy.app/${data.paste.id}`;
}

// Ekstrak kode lua dari konten (hapus ```lua blok jika ada)
function extractLua(content) {
  const match = content.match(/```(?:lua)?\n([\s\S]*?)```/);
  return match ? match[1].trim() : content.trim();
}

// ─── AI Providers (Gemini → Groq fallback) ───────────

async function callGemini(systemPrompt, userMessage) {
  const apiKey = process.env.GEMINI_API_KEY;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: { maxOutputTokens: 8192, temperature: 0.2 },
      }),
    }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const isLimit = res.status === 429 || res.status === 503;
    throw { isLimit, message: `Gemini error ${res.status}: ${data.error?.message || "unknown"}` };
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini tidak mengembalikan teks");
  return { text: text.trim(), provider: "Gemini" };
}

async function callGroq(systemPrompt, userMessage) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 8192,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const isLimit = res.status === 429 || res.status === 503;
    throw { isLimit, message: `Groq error ${res.status}: ${data.error?.message || "unknown"}` };
  }
  const data = await res.json();
  return { text: data.choices[0].message.content.trim(), provider: "Groq" };
}

// Fungsi utama: Gemini dulu → fallback ke Groq
async function callClaude(systemPrompt, userMessage) {
  // Coba Gemini dulu (lebih pintar untuk kode kompleks)
  if (process.env.GEMINI_API_KEY) {
    try {
      return (await callGemini(systemPrompt, userMessage)).text;
    } catch (err) {
      if (err.isLimit) {
        console.warn("⚠️ Gemini rate limit, beralih ke Groq...");
      } else {
        console.error("Gemini error:", err.message);
      }
      // Lanjut ke Groq
    }
  }
  // Fallback ke Groq
  if (process.env.GROQ_API_KEY) {
    try {
      return (await callGroq(systemPrompt, userMessage)).text;
    } catch (err) {
      throw new Error(`Semua AI provider gagal. Error Groq: ${err.message}`);
    }
  }
  throw new Error("Tidak ada AI provider yang dikonfigurasi. Set GEMINI_API_KEY atau GROQ_API_KEY.");
}

// Cek provider yang aktif saat startup
function getActiveProviders() {
  const providers = [];
  if (process.env.GEMINI_API_KEY) providers.push("Gemini (gemini-2.0-flash)");
  if (process.env.GEMINI_API_KEY) providers.push("Gemini (gemini-1.5-flash)");
  return providers;
}

// ─── Slash Commands ───────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("fixlua")
    .setDescription("Fix script Lua — tempel kode atau kirim link pastefy.app")
    .addStringOption((o) =>
      o.setName("input")
        .setDescription("Script Lua langsung ATAU link pastefy.app/ID")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("checklua")
    .setDescription("Cek bug dalam script Lua — tempel kode atau kirim link pastefy.app")
    .addStringOption((o) =>
      o.setName("input")
        .setDescription("Script Lua langsung ATAU link pastefy.app/ID")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("explainlua")
    .setDescription("Jelaskan script Lua — tempel kode atau kirim link pastefy.app")
    .addStringOption((o) =>
      o.setName("input")
        .setDescription("Script Lua langsung ATAU link pastefy.app/ID")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("cleanlua")
    .setDescription("Bersihkan + fix script Lua: hapus kode mati, rapikan format, perbaiki bug")
    .addStringOption((o) =>
      o.setName("input")
        .setDescription("Script Lua langsung ATAU link pastefy.app/ID")
        .setRequired(true)
    )
    .addBooleanOption((o) =>
      o.setName("aggressive")
        .setDescription("Hapus komentar lama & refactor lebih dalam (default: false)")
        .setRequired(false)
    ),
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

async function registerCommands() {
  try {
    console.log("Mendaftarkan slash commands...");
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log("Slash commands berhasil didaftarkan!");
  } catch (err) {
    console.error("Gagal mendaftarkan commands:", err);
  }
}

// ─── Resolve input: bisa kode langsung atau link pastefy ─
async function resolveScript(input) {
  const isPastefyUrl = input.includes("pastefy.app");
  const pasteId = parsePastefyId(input);

  if (pasteId && isPastefyUrl) {
    // Input jelas URL Pastefy — wajib berhasil, lempar error kalau gagal
    const paste = await fetchPaste(pasteId);
    return {
      script: extractLua(paste.content),
      source: `pastefy.app/${paste.id}`,
      title: paste.title || "Lua Script",
      fromPastefy: true,
    };
  }

  if (pasteId && !/[\n;{}]/.test(input)) {
    // Input mungkin ID Pastefy (tidak ada newline/kode) — coba fetch, tapi tidak masalah kalau gagal
    try {
      const paste = await fetchPaste(pasteId);
      return {
        script: extractLua(paste.content),
        source: `pastefy.app/${paste.id}`,
        title: paste.title || "Lua Script",
        fromPastefy: true,
      };
    } catch (e) {
      console.log("Bukan ID Pastefy, anggap kode biasa:", e.message);
    }
  }

  // Input adalah kode Lua langsung
  return { script: input.trim(), source: null, title: "Lua Script", fromPastefy: false };
}

// ─── /fixlua ─────────────────────────────────────────
async function handleFixLua(interaction) {
  const input = interaction.options.getString("input");
  await interaction.deferReply();

  let scriptInfo;
  try {
    scriptInfo = await resolveScript(input);
  } catch (err) {
    return interaction.editReply({ content: `❌ ${err.message}` });
  }

  const { script, source, title } = scriptInfo;

  const systemPrompt = `Kamu adalah ahli Lua dan Roblox Luau. Tugasmu HANYA memperbaiki bug dan error pada script Lua yang diberikan.

ATURAN WAJIB — JANGAN DILANGGAR:
1. JANGAN hapus, ubah, atau sederhanakan SATU PUN fungsi atau fitur yang sudah ada
2. JANGAN ubah struktur program secara keseluruhan
3. JANGAN gabungkan atau pisahkan fungsi yang ada
4. HANYA perbaiki: syntax error, logic error yang jelas, typo nama fungsi/service
5. Pertahankan 100% semua: DataStore calls, Remote Events, collision groups, cache, event listeners
6. Jika ragu apakah sesuatu adalah bug atau fitur — PERTAHANKAN saja
7. Output harus bisa langsung dijalankan di Roblox Studio

Format responmu HARUS persis seperti ini (gunakan pemisah ---SPLIT---):
BUGS:
[daftar bug yang ditemukan, satu per baris, format: "Baris X: deskripsi masalah". Jika tidak ada tulis: Tidak ada bug ditemukan.]
---SPLIT---
FIXED:
[script yang sudah diperbaiki, kode Lua murni saja, TANPA markdown backtick, TANPA penjelasan]
---SPLIT---
PENJELASAN:
[penjelasan singkat perubahan, maksimal 3 poin]`;

  const raw = await callClaude(systemPrompt, `Perbaiki script Lua ini:\n\`\`\`lua\n${script}\n\`\`\``);
  const parts = raw.split("---SPLIT---").map((p) => p.trim());

  const bugsSection = (parts[0] || "").replace(/^BUGS:\s*/i, "").trim();
  const fixedSection = (parts[1] || "").replace(/^FIXED:\s*/i, "").trim();
  const penjelasan = (parts[2] || "").replace(/^PENJELASAN:\s*/i, "").trim();

  const hasBugs = !/tidak ada bug/i.test(bugsSection) && bugsSection.length > 5;

  // Upload hasil ke Pastefy
  let pastefyUrl = null;
  try {
    pastefyUrl = await uploadToPastefy(`[Fixed] ${title}`, fixedSection);
  } catch (_) {}

  const bugEmbed = new EmbedBuilder()
    .setTitle(hasBugs ? "⚠️ Bug Ditemukan" : "✅ Tidak Ada Bug")
    .setColor(hasBugs ? 0xed4245 : 0x57f287)
    .setDescription(codeBlock(bugsSection))
    .setFooter({ text: source ? `Sumber: ${source}` : "LuaFixBot • Claude AI" });

  const fixEmbed = new EmbedBuilder()
    .setTitle("🔧 Script Sudah Diperbaiki")
    .setColor(0x5865f2)
    .setDescription(
      fixedSection.length > 1800
        ? `Script terlalu panjang untuk ditampilkan di sini.\n\n📋 **Lihat hasil di Pastefy:** ${pastefyUrl || "(gagal upload)"}`
        : codeBlock("lua", fixedSection)
    )
    .addFields({ name: "📝 Perubahan", value: penjelasan || "Tidak ada perubahan." });

  if (pastefyUrl) {
    fixEmbed.addFields({ name: "🔗 Pastefy", value: pastefyUrl });
  }

  await interaction.editReply({ embeds: [bugEmbed, fixEmbed] });
}

// ─── /checklua ───────────────────────────────────────
async function handleCheckLua(interaction) {
  const input = interaction.options.getString("input");
  await interaction.deferReply();

  let scriptInfo;
  try {
    scriptInfo = await resolveScript(input);
  } catch (err) {
    return interaction.editReply({ content: `❌ ${err.message}` });
  }

  const { script, source } = scriptInfo;

  const systemPrompt = `Kamu adalah ahli Lua dan Roblox Luau. Cek script dan temukan semua bug, error, dan masalah potensial.

Format:
- Baris [nomor]: [deskripsi masalah] — [KRITIS/PERINGATAN/INFO]

Jika tidak ada masalah, tulis: ✅ Script terlihat baik-baik saja.
Jangan perbaiki, hanya analisis.`;

  const result = await callClaude(systemPrompt, `Cek script Lua ini:\n\`\`\`lua\n${script}\n\`\`\``);

  const embed = new EmbedBuilder()
    .setTitle("🔍 Hasil Pengecekan Script Lua")
    .setColor(0xfee75c)
    .setDescription(result.length > 4000 ? result.slice(0, 4000) + "\n..." : result)
    .setFooter({ text: source ? `Sumber: ${source}` : "LuaFixBot • Gunakan /fixlua untuk memperbaiki" });

  await interaction.editReply({ embeds: [embed] });
}

// ─── /explainlua ─────────────────────────────────────
async function handleExplainLua(interaction) {
  const input = interaction.options.getString("input");
  await interaction.deferReply();

  let scriptInfo;
  try {
    scriptInfo = await resolveScript(input);
  } catch (err) {
    return interaction.editReply({ content: `❌ ${err.message}` });
  }

  const { script, source } = scriptInfo;

  const systemPrompt = `Kamu adalah tutor Lua dan Roblox yang ramah. Jelaskan script dalam Bahasa Indonesia.

Struktur:
1. **Ringkasan**: apa yang dilakukan script (1-2 kalimat)
2. **Penjelasan per bagian**: setiap bagian penting
3. **Catatan**: tips atau hal penting

Gunakan bahasa sederhana.`;

  const result = await callClaude(systemPrompt, `Jelaskan script Lua ini:\n\`\`\`lua\n${script}\n\`\`\``);

  const embed = new EmbedBuilder()
    .setTitle("📚 Penjelasan Script Lua")
    .setColor(0x57f287)
    .setDescription(result.length > 4000 ? result.slice(0, 4000) + "\n..." : result)
    .setFooter({ text: source ? `Sumber: ${source}` : "LuaFixBot • Powered by Claude AI" });

  await interaction.editReply({ embeds: [embed] });
}


// ─── /cleanlua ───────────────────────────────────────
async function handleCleanLua(interaction) {
  const input = interaction.options.getString("input");
  const aggressive = interaction.options.getBoolean("aggressive") ?? false;
  await interaction.deferReply();

  let scriptInfo;
  try {
    scriptInfo = await resolveScript(input);
  } catch (err) {
    return interaction.editReply({ content: `❌ ${err.message}` });
  }

  const { script, source, title } = scriptInfo;

  const aggressiveNote = aggressive
    ? `- Hapus semua komentar yang tidak relevan atau sudah usang
- Refactor variabel dengan nama tidak jelas (misal: a, b, x) menjadi nama deskriptif
- Pisahkan logika kompleks menjadi fungsi-fungsi kecil jika perlu`
    : `- Pertahankan semua komentar yang masih relevan
- Jangan ubah nama variabel kecuali typo jelas`;

  const systemPrompt = `Kamu adalah ahli Lua dan Roblox Luau. Tugasmu: BERSIHKAN dan RAPIKAN script Lua TANPA menghilangkan satu pun logic/fitur yang ada.

ATURAN WAJIB — INI YANG BOLEH DILAKUKAN:
✅ Rename variabel tidak jelas (r1, r24, v3) menjadi nama deskriptif
✅ Rapikan indentasi menjadi konsisten 2 spasi
✅ Tambahkan komentar section (-- Services, -- DataStore, dll)
✅ Hapus HANYA kode yang 100% tidak berfungsi: infinite loop kosong, dead code yang provably unreachable
✅ Perbaiki bug sintaks dan typo

ATURAN WAJIB — INI YANG DILARANG:
❌ JANGAN hapus fungsi apapun meskipun terlihat redundan
❌ JANGAN hapus DataStore calls (GetAsync, SetAsync)
❌ JANGAN hapus Remote Events/Functions apapun
❌ JANGAN hapus collision group rules
❌ JANGAN hapus cache (gamepassCache, banListCache, dll)
❌ JANGAN gabungkan atau pisahkan fungsi yang sudah ada
❌ JANGAN sederhanakan logic yang kompleks — biarkan apa adanya
❌ JANGAN ubah nama fungsi yang dipanggil dari luar script
❌ JANGAN hapus event listeners (PlayerAdded, PlayerRemoving, dll)
${aggressiveNote}

PENTING: Jika script asli menggunakan obfuscation/tamper detection — HAPUS seluruh bagian obfuscation tersebut, tapi PERTAHANKAN semua logic bisnis di dalamnya.

Format HARUS persis seperti ini (gunakan pemisah ---SPLIT---):
LAPORAN:
[ringkasan perubahan dalam 3 kategori:
🐛 Bug Diperbaiki: (list atau "Tidak ada")
🧹 Dibersihkan: (list rename variabel, hapus obfuscation, dll)
✨ Dioptimalkan: (list atau "Tidak ada")]
---SPLIT---
CLEAN:
[script hasil bersih, kode Lua murni saja, TANPA markdown backtick, TANPA penjelasan tambahan]
---SPLIT---
STATS:
[3 baris:
Baris sebelum: X
Baris sesudah: Y
Pengurangan: Z%]`;

  const raw = await callClaude(systemPrompt, `Bersihkan dan fix script Lua ini:\n\`\`\`lua\n${script}\n\`\`\``);
  const parts = raw.split("---SPLIT---").map((p) => p.trim());

  const laporan = (parts[0] || "").replace(/^LAPORAN:\s*/i, "").trim();
  const cleanScript = (parts[1] || "").replace(/^CLEAN:\s*/i, "").trim();
  const stats = (parts[2] || "").replace(/^STATS:\s*/i, "").trim();

  let pastefyUrl = null;
  try {
    pastefyUrl = await uploadToPastefy(`[Clean] ${title}`, cleanScript);
  } catch (_) {}

  const reportEmbed = new EmbedBuilder()
    .setTitle(`🧹 Laporan Pembersihan${aggressive ? " (Aggressive Mode)" : ""}`)
    .setColor(0xeb459e)
    .setDescription(laporan.length > 3000 ? laporan.slice(0, 3000) + "\n..." : laporan)
    .setFooter({ text: source ? `Sumber: ${source}` : "LuaFixBot • Claude AI" });

  if (stats) {
    reportEmbed.addFields({ name: "📊 Statistik", value: codeBlock(stats) });
  }

  const resultEmbed = new EmbedBuilder()
    .setTitle("✨ Script Bersih & Terfix")
    .setColor(0x57f287)
    .setDescription(
      cleanScript.length > 1800
        ? `Script terlalu panjang.\n\n📋 **Lihat hasil di Pastefy:** ${pastefyUrl || "(gagal upload)"}`
        : codeBlock("lua", cleanScript)
    );

  if (pastefyUrl) {
    resultEmbed.addFields({ name: "🔗 Pastefy", value: pastefyUrl });
  }

  await interaction.editReply({ embeds: [reportEmbed, resultEmbed] });
}

// ─── Events ───────────────────────────────────────────
client.once("ready", () => {
  const providers = getActiveProviders();
  console.log(`✅ Bot aktif sebagai ${client.user.tag}`);
  console.log(`🤖 AI Providers aktif: ${providers.join(" → ") || "TIDAK ADA!"}`);
  if (providers.length === 0) {
    console.error("❌ WARNING: Set GROQ_API_KEY dan/atau GEMINI_API_KEY di environment variables!");
  }
  client.user.setActivity("/cleanlua | Gemini + Groq", { type: 3 });
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === "fixlua") await handleFixLua(interaction);
    else if (interaction.commandName === "checklua") await handleCheckLua(interaction);
    else if (interaction.commandName === "explainlua") await handleExplainLua(interaction);
    else if (interaction.commandName === "cleanlua") await handleCleanLua(interaction);
  } catch (err) {
    console.error("Error:", err);
    const msg = { content: "❌ Terjadi error. Coba lagi sebentar.", ephemeral: true };
    if (interaction.deferred) await interaction.editReply(msg);
    else await interaction.reply(msg);
  }
});

// ─── Start ────────────────────────────────────────────
registerCommands().then(() => client.login(process.env.DISCORD_TOKEN));
