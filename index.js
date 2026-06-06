// Alaric External — Auth Server + Discord Bot
// ─────────────────────────────────────────────
// Handles:
//   - /verify  (POST) — called by AlaricExternal.exe on every launch
//   - Discord slash commands: /getkey /revokekey /listkeys /status
//
// Setup:
//   1. Fill in config.js with your Discord bot token, guild ID, admin role ID
//   2. npm install
//   3. node index.js
//   4. Host on Railway / Render / VPS — set PORT env var

const express    = require("express");
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const Database   = require("better-sqlite3");
const { v4: uuidv4 } = require("uuid");
const fs         = require("fs");

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG = {
    DISCORD_TOKEN:  process.env.DISCORD_TOKEN  || "",
    CLIENT_ID:      process.env.CLIENT_ID      || "1512777510306447420",
    GUILD_ID:       process.env.GUILD_ID       || "1510593194679865405",
    ADMIN_ROLE_ID:  process.env.ADMIN_ROLE_ID  || "1512778579048665230",
    PORT:           process.env.PORT           || 3000,
    API_SECRET:     process.env.API_SECRET     || "alaric_server_secret_change_this",
};

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database("alaric_keys.db");

db.exec(`
    CREATE TABLE IF NOT EXISTS keys (
        key         TEXT PRIMARY KEY,
        discord_id  TEXT NOT NULL UNIQUE,
        discord_tag TEXT,
        hwid        TEXT DEFAULT NULL,
        created_at  TEXT DEFAULT (datetime('now')),
        last_seen   TEXT DEFAULT NULL,
        active      INTEGER DEFAULT 1
    );
`);

const stmt = {
    getByKey:       db.prepare("SELECT * FROM keys WHERE key = ?"),
    getByDiscord:   db.prepare("SELECT * FROM keys WHERE discord_id = ?"),
    insert:         db.prepare("INSERT INTO keys (key, discord_id, discord_tag) VALUES (?, ?, ?)"),
    setHwid:        db.prepare("UPDATE keys SET hwid = ?, last_seen = datetime('now') WHERE key = ?"),
    updateSeen:     db.prepare("UPDATE keys SET last_seen = datetime('now') WHERE key = ?"),
    revoke:         db.prepare("UPDATE keys SET active = 0 WHERE key = ?"),
    revokeByUser:   db.prepare("UPDATE keys SET active = 0 WHERE discord_id = ?"),
    resetHwid:      db.prepare("UPDATE keys SET hwid = NULL WHERE key = ?"),
    listAll:        db.prepare("SELECT key, discord_id, discord_tag, hwid, created_at, last_seen, active FROM keys ORDER BY created_at DESC"),
    activate:       db.prepare("UPDATE keys SET active = 1 WHERE key = ?"),
};

// ── Key generation ────────────────────────────────────────────────────────────
function generateKey() {
    return "alaric_" + uuidv4().replace(/-/g, "").substring(0, 24);
}

// ── Express API ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// POST /verify — called by AlaricExternal.exe
// Body: { key: string, hwid: string, secret: string }
app.post("/verify", (req, res) => {
    const { key, hwid, secret } = req.body;

    // Validate internal secret so random people can't spam the endpoint
    if (secret !== CONFIG.API_SECRET) {
        return res.json({ valid: false, status: "unauthorized" });
    }

    if (!key || !hwid) {
        return res.json({ valid: false, status: "missing_fields" });
    }

    const row = stmt.getByKey.get(key);

    if (!row) {
        return res.json({ valid: false, status: "not_found", message: "Key not found." });
    }

    if (!row.active) {
        return res.json({ valid: false, status: "revoked", message: "Key has been revoked." });
    }

    // First use — bind HWID to key
    if (!row.hwid) {
        stmt.setHwid.run(hwid, key);
        return res.json({ valid: true, status: "ok", message: "Key activated." });
    }

    // HWID mismatch — key used on different machine
    if (row.hwid !== hwid) {
        return res.json({ valid: false, status: "hwid_mismatch", message: "This key is locked to a different device." });
    }

    // All good
    stmt.updateSeen.run(key);
    return res.json({ valid: true, status: "ok", message: "Authenticated." });
});

app.listen(CONFIG.PORT, () => {
    console.log(`[Server] Listening on port ${CONFIG.PORT}`);
});

// ── Discord Bot ───────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Register slash commands
const commands = [
    new SlashCommandBuilder()
        .setName("getkey")
        .setDescription("Get your Alaric External key (one per user)"),

    new SlashCommandBuilder()
        .setName("mykey")
        .setDescription("Show your current key and status"),

    new SlashCommandBuilder()
        .setName("revokekey")
        .setDescription("[Admin] Revoke a user's key")
        .addUserOption(o => o.setName("user").setDescription("User to revoke").setRequired(true)),

    new SlashCommandBuilder()
        .setName("resetkey")
        .setDescription("[Admin] Reset a user's key (new key, clears HWID)")
        .addUserOption(o => o.setName("user").setDescription("User to reset").setRequired(true)),

    new SlashCommandBuilder()
        .setName("resethwid")
        .setDescription("[Admin] Reset HWID lock for a user (keep key)")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true)),

    new SlashCommandBuilder()
        .setName("listkeys")
        .setDescription("[Admin] List all keys"),

    new SlashCommandBuilder()
        .setName("keyinfo")
        .setDescription("[Admin] Look up a specific user's key info")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true)),
].map(c => c.toJSON());

client.once("ready", async () => {
    console.log(`[Bot] Logged in as ${client.user.tag}`);
    try {
        const rest = new REST({ version: "10" }).setToken(CONFIG.DISCORD_TOKEN);
        await rest.put(Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID), { body: commands });
        console.log("[Bot] Slash commands registered");
    } catch (e) {
        console.error("[Bot] Failed to register commands:", e);
    }
});

client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const isAdmin = interaction.member?.roles?.cache?.has(CONFIG.ADMIN_ROLE_ID);
    const { commandName } = interaction;

    // ── /getkey ───────────────────────────────────────────────────────────────
    if (commandName === "getkey") {
        const existing = stmt.getByDiscord.get(interaction.user.id);
        if (existing) {
            const status = existing.active ? "✅ Active" : "❌ Revoked";
            return interaction.reply({
                content: `You already have a key.\n\`\`\`\n${existing.key}\n\`\`\`\nStatus: ${status}`,
                ephemeral: true
            });
        }

        const key = generateKey();
        stmt.insert.run(key, interaction.user.id, interaction.user.tag);

        return interaction.reply({
            content: `✅ **Your Alaric External key:**\n\`\`\`\n${key}\n\`\`\`\n⚠️ This key is locked to your device on first use. Do not share it — it will only work on one PC.`,
            ephemeral: true
        });
    }

    // ── /mykey ────────────────────────────────────────────────────────────────
    if (commandName === "mykey") {
        const row = stmt.getByDiscord.get(interaction.user.id);
        if (!row) {
            return interaction.reply({ content: "You don't have a key yet. Use `/getkey`.", ephemeral: true });
        }
        const status  = row.active ? "✅ Active" : "❌ Revoked";
        const hwid    = row.hwid ? "🔒 Locked to device" : "🔓 Not yet locked";
        const lastSeen = row.last_seen || "Never";
        return interaction.reply({
            content: `**Your key:**\n\`\`\`\n${row.key}\n\`\`\`\nStatus: ${status}\nDevice: ${hwid}\nLast seen: ${lastSeen}`,
            ephemeral: true
        });
    }

    // ── /revokekey (admin) ────────────────────────────────────────────────────
    if (commandName === "revokekey") {
        if (!isAdmin) return interaction.reply({ content: "No permission.", ephemeral: true });
        const target = interaction.options.getUser("user");
        const row = stmt.getByDiscord.get(target.id);
        if (!row) return interaction.reply({ content: `${target.tag} has no key.`, ephemeral: true });
        stmt.revokeByUser.run(target.id);
        return interaction.reply({ content: `🚫 Revoked key for **${target.tag}**.`, ephemeral: true });
    }

    // ── /resetkey (admin) ─────────────────────────────────────────────────────
    if (commandName === "resetkey") {
        if (!isAdmin) return interaction.reply({ content: "No permission.", ephemeral: true });
        const target = interaction.options.getUser("user");
        const row = stmt.getByDiscord.get(target.id);
        if (!row) return interaction.reply({ content: `${target.tag} has no key.`, ephemeral: true });
        stmt.revokeByUser.run(target.id);
        const newKey = generateKey();
        // Delete old and insert new
        db.prepare("DELETE FROM keys WHERE discord_id = ?").run(target.id);
        stmt.insert.run(newKey, target.id, target.tag);
        return interaction.reply({ content: `🔄 Reset key for **${target.tag}**.\nNew key: \`${newKey}\``, ephemeral: true });
    }

    // ── /resethwid (admin) ────────────────────────────────────────────────────
    if (commandName === "resethwid") {
        if (!isAdmin) return interaction.reply({ content: "No permission.", ephemeral: true });
        const target = interaction.options.getUser("user");
        const row = stmt.getByDiscord.get(target.id);
        if (!row) return interaction.reply({ content: `${target.tag} has no key.`, ephemeral: true });
        stmt.resetHwid.run(row.key);
        return interaction.reply({ content: `🔓 HWID reset for **${target.tag}**. They can activate on a new device.`, ephemeral: true });
    }

    // ── /listkeys (admin) ─────────────────────────────────────────────────────
    if (commandName === "listkeys") {
        if (!isAdmin) return interaction.reply({ content: "No permission.", ephemeral: true });
        const rows = stmt.listAll.all();
        if (rows.length === 0) return interaction.reply({ content: "No keys yet.", ephemeral: true });
        const lines = rows.map(r =>
            `${r.active ? "✅" : "❌"} **${r.discord_tag}** — \`${r.key.substring(0,20)}...\` ${r.hwid ? "🔒" : "🔓"}`
        ).join("\n");
        const chunks = lines.match(/.{1,1800}/gs) || [lines];
        await interaction.reply({ content: chunks[0], ephemeral: true });
        for (let i = 1; i < chunks.length; i++)
            await interaction.followUp({ content: chunks[i], ephemeral: true });
        return;
    }

    // ── /keyinfo (admin) ──────────────────────────────────────────────────────
    if (commandName === "keyinfo") {
        if (!isAdmin) return interaction.reply({ content: "No permission.", ephemeral: true });
        const target = interaction.options.getUser("user");
        const row = stmt.getByDiscord.get(target.id);
        if (!row) return interaction.reply({ content: `${target.tag} has no key.`, ephemeral: true });
        return interaction.reply({
            content: `**Key info for ${target.tag}:**\nKey: \`${row.key}\`\nStatus: ${row.active ? "✅ Active" : "❌ Revoked"}\nHWID: \`${row.hwid || "Not locked"}\`\nCreated: ${row.created_at}\nLast seen: ${row.last_seen || "Never"}`,
            ephemeral: true
        });
    }
});

client.login(CONFIG.DISCORD_TOKEN);
