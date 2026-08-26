#!/usr/bin/env node
/* Задаёт пароль владельца сайта на сервере.
 *
 *   node server/set-password.mjs [root@IP]
 *
 * Пароль никуда не записывается и не показывается: из него считается
 * PBKDF2-хеш со случайной солью, и на сервер по ssh уезжает только хеш.
 * Восстановить пароль из него нельзя — забыли, задайте новый этой же командой.
 * Смена пароля гасит все выданные сессии: токен подписан этим же секретом.
 */
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";

/* На своём сервере потолка процессорного времени нет — в отличие от Worker'а,
   где 200 000 итераций валили вход с ошибкой 1101. */
const ITER = 200000;
const TARGET = process.argv[2] || process.env.BIKES_TARGET || "root@109.68.212.36";
const KEY = process.env.SSH_KEY || `${homedir()}/.ssh/dit_vps_rsa`;
const b64url = b => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function ask(question) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // гасим эхо, чтобы пароль не остался в терминале и в истории
    const onData = () => rl.output.write("\x1B[2K\x1B[200D" + question);
    rl.output.write(question);
    rl.input.on("data", onData);
    rl.question("", a => { rl.input.off("data", onData); rl.output.write("\n"); rl.close(); resolve(a); });
  });
}

const pw = (await ask("Придумайте пароль: ")).trim();
if (pw.length < 10) {
  console.error("\nСлишком короткий — нужно хотя бы 10 символов. Этот пароль защищает запись в ваш журнал.");
  process.exit(1);
}
if ((await ask("Повторите пароль: ")).trim() !== pw) { console.error("\nПароли не совпали."); process.exit(1); }

const salt = randomBytes(16);
const secret = `pbkdf2$${ITER}$${b64url(salt)}$${b64url(pbkdf2Sync(pw, salt, ITER, 32, "sha256"))}`;

console.log(`\nОтправляю хеш на ${TARGET}…`);
const r = spawnSync("ssh", ["-i", KEY, "-o", "StrictHostKeyChecking=accept-new", TARGET,
  "umask 177 && cat > /etc/bikes.env && systemctl restart bikes && sleep 1 && systemctl is-active bikes"], {
  input: `AUTH=${secret}\n`, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"],
});
if (r.status === 0) console.log("Пароль задан, сервис перезапущен. Старые сессии погашены — войдите заново.");
process.exit(r.status ?? 1);
