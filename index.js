// Alaric External — Auth Server + Discord Bot
const express = require("express");
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { v4: uuidv4 } = require("uuid");
const fs   = require("fs");
const path = require("path");

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG = {
    DISCORD_TOKEN: process.env.DISCORD_TOKEN || "",
    CLIENT_ID:     process.env.CLIENT_ID     || "1512777510306447420",
    GUILD_ID:      process.env.GUILD_ID      || "1510593194679865405",
    ADMIN_ROLE_ID: process.env.ADMIN_ROLE_ID || "1512778579048665230",
    PORT:          process.env.PORT          || 3000,
    API_SECRET:    process.env.API_SECRET    || "alaric_secret_2024",
};

// ── Simple JSON database ──────────────────────────────────────────────────────
const DB_FILE = path.join(__dirname, "db.json");

function loadDB() {
    if (!fs.existsSync(DB_FILE)) return { keys: [] };
    try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
    catch { return { keys: [] }; }
}

function saveDB(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function getByKey(key) {
    return loadDB().keys.find(r => r.key === key) || null;
}

function getByDiscord(discordId) {
    return loadDB().keys.find(r => r.discord_id === discordId) || null;
}

function insertKey(key, discordId, discordTag) {
    const db = loadDB();
    db.keys.push({ key, discord_id: discordId, discord_tag: discordTag,
        hwid: null, created_at: new Date().toISOString(), last_seen: null, active: true });
    saveDB(db);
}

function updateRow(key, patch) {
    const db = loadDB();
    const idx = db.keys.findIndex(r => r.key === key);
    if (idx !== -1) { db.keys[idx] = { ...db.keys[idx], ...patch }; saveDB(db); }
}

function revokeByDiscord(discordId) {
    const db = loadDB();
    db.keys.forEach(r => { if (r.discord_id === discordId) r.active = false; });
    saveDB(db);
}

function deleteByDiscord(discordId) {
    const db = loadDB();
    db.keys = db.keys.filter(r => r.discord_id !== discordId);
    saveDB(db);
}

function listAll() { return loadDB().keys; }

function generateKey() {
    return "alaric_" + uuidv4().replace(/-/g, "").substring(0, 24);
}

// ── Express API ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.post("/verify", (req, res) => {
    const { key, hwid, secret } = req.body || {};
    if (secret !== CONFIG.API_SECRET) return res.json({ valid: false, status: "unauthorized" });
    if (!key || !hwid) return res.json({ valid: false, status: "missing_fields" });

    const row = getByKey(key);
    if (!row) return res.json({ valid: false, status: "not_found", message: "Key not found." });
    if (!row.active) return res.json({ valid: false, status: "revoked", message: "Key revoked." });

    if (!row.hwid) {
        updateRow(key, { hwid, last_seen: new Date().toISOString() });
        return res.json({ valid: true, status: "ok", message: "Key activated." });
    }
    if (row.hwid !== hwid) return res.json({ valid: false, status: "hwid_mismatch", message: "Key locked to different device." });

    updateRow(key, { last_seen: new Date().toISOString() });
    return res.json({ valid: true, status: "ok", message: "Authenticated." });
});

app.get("/", (req, res) => res.send("Alaric Auth Server running."));

app.listen(CONFIG.PORT, () => console.log(`[Server] Listening on port ${CONFIG.PORT}`));

// ── Discord Bot ───────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    new SlashCommandBuilder().setName("getkey").setDescription("Get your Alaric External key"),
    new SlashCommandBuilder().setName("mykey").setDescription("Show your key and status"),
    new SlashCommandBuilder().setName("revokekey").setDescription("[Admin] Revoke a user's key")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true)),
    new SlashCommandBuilder().setName("resetkey").setDescription("[Admin] Give user a new key")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true)),
    new SlashCommandBuilder().setName("resethwid").setDescription("[Admin] Reset HWID for a user")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true)),
    new SlashCommandBuilder().setName("keyinfo").setDescription("[Admin] View a user's key info")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true)),
    new SlashCommandBuilder().setName("listkeys").setDescription("[Admin] List all keys"),
].map(c => c.toJSON());

client.once("ready", async () => {
    console.log(`[Bot] Logged in as ${client.user.tag}`);
    try {
        const rest = new REST({ version: "10" }).setToken(CONFIG.DISCORD_TOKEN);
        await rest.put(Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID), { body: commands });
        console.log("[Bot] Slash commands registered");
    } catch (e) { console.error("[Bot] Failed to register commands:", e.message); }
});

client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const isAdmin = interaction.member?.roles?.cache?.has(CONFIG.ADMIN_ROLE_ID);
    const { commandName } = interaction;

    if (commandName === "getkey") {
        const existing = getByDiscord(interaction.user.id);
        if (existing) {
            const status = existing.active ? "✅ Active" : "❌ Revoked";
            return interaction.reply({ content: `You already have a key.\n\`\`\`\n${existing.key}\n\`\`\`Status: ${status}`, ephemeral: true });
        }
        const key = generateKey();
        insertKey(key, interaction.user.id, interaction.user.tag);
        return interaction.reply({ content: `✅ **Your Alaric External key:**\n\`\`\`\n${key}\n\`\`\`⚠️ This key locks to your device on first use. Do not share it.`, ephemeral: true });
    }

    if (commandName === "mykey") {
        const row = getByDiscord(interaction.user.id);
        if (!row) return interaction.reply({ content: "No key yet. Use `/getkey`.", ephemeral: true });
        return interaction.reply({ content: `**Your key:**\n\`\`\`\n${row.key}\n\`\`\`Status: ${row.active ? "✅ Active" : "❌ Revoked"}\nDevice: ${row.hwid ? "🔒 Locked" : "🔓 Not yet locked"}\nLast seen: ${row.last_seen || "Never"}`, ephemeral: true });
    }

    if (commandName === "revokekey") {
        if (!isAdmin) return interaction.reply({ content: "No permission.", ephemeral: true });
        const target = interaction.options.getUser("user");
        const row = getByDiscord(target.id);
        if (!row) return interaction.reply({ content: `${target.tag} has no key.`, ephemeral: true });
        revokeByDiscord(target.id);
        return interaction.reply({ content: `🚫 Revoked key for **${target.tag}**.`, ephemeral: true });
    }

    if (commandName === "resetkey") {
        if (!isAdmin) return interaction.reply({ content: "No permission.", ephemeral: true });
        const target = interaction.options.getUser("user");
        deleteByDiscord(target.id);
        const newKey = generateKey();
        insertKey(newKey, target.id, target.tag);
        return interaction.reply({ content: `🔄 New key for **${target.tag}**:\n\`\`\`\n${newKey}\n\`\`\``, ephemeral: true });
    }

    if (commandName === "resethwid") {
        if (!isAdmin) return interaction.reply({ content: "No permission.", ephemeral: true });
        const target = interaction.options.getUser("user");
        const row = getByDiscord(target.id);
        if (!row) return interaction.reply({ content: `${target.tag} has no key.`, ephemeral: true });
        updateRow(row.key, { hwid: null });
        return interaction.reply({ content: `🔓 HWID reset for **${target.tag}**.`, ephemeral: true });
    }

    if (commandName === "keyinfo") {
        if (!isAdmin) return interaction.reply({ content: "No permission.", ephemeral: true });
        const target = interaction.options.getUser("user");
        const row = getByDiscord(target.id);
        if (!row) return interaction.reply({ content: `${target.tag} has no key.`, ephemeral: true });
        return interaction.reply({ content: `**${target.tag}**\nKey: \`${row.key}\`\nStatus: ${row.active ? "✅" : "❌"}\nHWID: \`${row.hwid || "Not locked"}\`\nCreated: ${row.created_at}\nLast seen: ${row.last_seen || "Never"}`, ephemeral: true });
    }

    if (commandName === "listkeys") {
        if (!isAdmin) return interaction.reply({ content: "No permission.", ephemeral: true });
        const rows = listAll();
        if (!rows.length) return interaction.reply({ content: "No keys yet.", ephemeral: true });
        const lines = rows.map(r => `${r.active ? "✅" : "❌"} **${r.discord_tag}** ${r.hwid ? "🔒" : "🔓"}`).join("\n");
        return interaction.reply({ content: lines.substring(0, 1900), ephemeral: true });
    }
});

if (CONFIG.DISCORD_TOKEN) {
    client.login(CONFIG.DISCORD_TOKEN).catch(e => console.error("[Bot] Login failed:", e.message));
} else {
    console.warn("[Bot] No DISCORD_TOKEN set — bot disabled");
}
